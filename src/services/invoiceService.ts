import type {
  Cents,
  Invoice,
  InvoiceCategory,
  InvoiceFile,
  InvoiceInput,
  InvoiceStatus,
} from '../types';
import { INVOICE_CATEGORIES, INVOICE_STATUSES } from '../types';
import { isDateString } from '../utils/date';
import { AppError, toErrorInfo } from '../utils/errors';
import {
  STORE,
  countByIndex,
  getAllByIndex,
  withStore,
  withTransaction,
} from './db';
import { getTrip } from './tripService';

/**
 * 发票的数据访问层：元数据与 PDF 文件都保存在 IndexedDB。
 *
 * 一致性与引用完整性约定：
 * - 元数据与文件在**同一个事务**中写入，任一失败则整体回滚，不会出现「元数据保存成功但文件不存在」。
 * - `fileId` 由本模块生成，不接受外部传入，避免悬空引用。
 * - 删除发票时先统计该文件是否仍被其它发票引用，只有无其它引用时才清理文件。
 * - 关联出差前会校验出差记录存在，拒绝建立无效关联。
 * - 失败时抛出带稳定错误码的 {@link AppError}。
 */

function generateId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function wrapDbError(error: unknown, fallbackMessage: string): AppError {
  const info = toErrorInfo(error);
  return new AppError('DB_ERROR', `${fallbackMessage}：${info.message}`);
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isInvoiceCategory(value: string): value is InvoiceCategory {
  return (INVOICE_CATEGORIES as readonly string[]).includes(value);
}

function isInvoiceStatus(value: string): value is InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(value);
}

/**
 * 校验并归一化发票输入。
 *
 * 关键规则：`status` 为 `confirmed` 时必须有金额；金额缺失时保持 undefined，
 * 绝不自动填 0 —— 否则会凭空造出一张「0 元有效发票」。
 */
export function validateInvoiceInput(input: InvoiceInput): InvoiceInput {
  if (!isInvoiceCategory(input.category)) {
    throw new AppError('INVALID_CATEGORY', '发票类别不合法。');
  }
  if (!isInvoiceStatus(input.status)) {
    throw new AppError('INVALID_STATUS', '发票识别状态不合法。');
  }

  const amountCents = input.amountCents;
  if (amountCents !== undefined) {
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
      throw new AppError('INVALID_AMOUNT', '发票金额必须是不小于 0 的整数分。');
    }
  }
  if (input.status === 'confirmed' && amountCents === undefined) {
    throw new AppError(
      'AMOUNT_REQUIRED',
      '标记为「已确认」前必须填写金额，缺失金额不会按 0 元处理。',
    );
  }

  const issuedAt = trimToUndefined(input.issuedAt);
  if (issuedAt !== undefined && !isDateString(issuedAt)) {
    throw new AppError('INVALID_DATE', '开票日期不合法，需为 YYYY-MM-DD。');
  }

  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw new AppError('INVALID_SIZE', '文件大小不合法。');
  }

  const invoiceNumber = trimToUndefined(input.invoiceNumber);
  const sellerName = trimToUndefined(input.sellerName);
  const tripId = trimToUndefined(input.tripId);
  const rawText = input.rawText === undefined ? undefined : input.rawText;

  return {
    category: input.category,
    status: input.status,
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
    source: input.source,
    ...(invoiceNumber !== undefined ? { invoiceNumber } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(sellerName !== undefined ? { sellerName } : {}),
    ...(amountCents !== undefined ? { amountCents } : {}),
    ...(tripId !== undefined ? { tripId } : {}),
    ...(rawText !== undefined ? { rawText } : {}),
  };
}

/** 关联出差前校验其真实存在，拒绝无效关联。 */
async function assertTripExists(tripId: string | undefined): Promise<void> {
  if (tripId === undefined) {
    return;
  }
  const trip = await getTrip(tripId);
  if (!trip) {
    throw new AppError(
      'INVALID_TRIP_LINK',
      '要关联的出差记录不存在，无法建立关联。',
    );
  }
}

/** 查询条件；同时提供多个条件时在内存中求交集。 */
export interface InvoiceQuery {
  category?: InvoiceCategory;
  tripId?: string;
  status?: InvoiceStatus;
}

function sortInvoices(invoices: Invoice[]): Invoice[] {
  return invoices.sort((a, b) => {
    const aDate = a.issuedAt ?? '';
    const bDate = b.issuedAt ?? '';
    if (aDate !== bDate) {
      return bDate.localeCompare(aDate);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** 查询发票列表，支持按类别、出差 ID 与识别状态过滤。 */
export async function listInvoices(query: InvoiceQuery = {}): Promise<Invoice[]> {
  try {
    const { category, tripId, status } = query;
    const filters = [category, tripId, status].filter(
      (value) => value !== undefined,
    );

    // 单一条件时走索引，多条件时取全集后在内存求交集（个人应用数据量小）。
    if (filters.length === 1) {
      if (category !== undefined) {
        return sortInvoices(
          await getAllByIndex<Invoice>(STORE.invoices, 'by_category', category),
        );
      }
      if (tripId !== undefined) {
        return sortInvoices(
          await getAllByIndex<Invoice>(STORE.invoices, 'by_tripId', tripId),
        );
      }
      if (status !== undefined) {
        return sortInvoices(
          await getAllByIndex<Invoice>(STORE.invoices, 'by_status', status),
        );
      }
    }

    const all = await withStore<Invoice[]>(STORE.invoices, 'readonly', (store) =>
      store.getAll(),
    );
    return sortInvoices(
      all.filter(
        (invoice) =>
          (category === undefined || invoice.category === category) &&
          (tripId === undefined || invoice.tripId === tripId) &&
          (status === undefined || invoice.status === status),
      ),
    );
  } catch (error) {
    throw wrapDbError(error, '读取发票失败');
  }
}

/** 根据 ID 获取单条发票；不存在时返回 null。 */
export async function getInvoice(id: string): Promise<Invoice | null> {
  if (id.trim() === '') {
    throw new AppError('INVALID_ID', '发票 ID 不能为空。');
  }
  try {
    const invoice = await withStore<Invoice | undefined>(
      STORE.invoices,
      'readonly',
      (store) => store.get(id),
    );
    return invoice ?? null;
  } catch (error) {
    throw wrapDbError(error, '读取发票失败');
  }
}

/** 读取发票文件；不存在时返回 null。 */
export async function getInvoiceFile(fileId: string): Promise<InvoiceFile | null> {
  if (fileId.trim() === '') {
    throw new AppError('INVALID_ID', '文件 ID 不能为空。');
  }
  try {
    const file = await withStore<InvoiceFile | undefined>(
      STORE.invoiceFiles,
      'readonly',
      (store) => store.get(fileId),
    );
    return file ?? null;
  } catch (error) {
    throw wrapDbError(error, '读取发票文件失败');
  }
}

/**
 * 创建发票。
 *
 * 若提供 `file`，元数据与文件会在同一个事务中写入：
 * 任一步失败都会回滚，不会出现「元数据存在但文件缺失」或反之。
 */
export async function createInvoice(
  input: InvoiceInput,
  file?: Blob,
): Promise<Invoice> {
  const validated = validateInvoiceInput(input);
  await assertTripExists(validated.tripId);

  if (file && validated.fileName.trim() === '') {
    throw new AppError('INVALID_FILE_NAME', '上传文件时必须有文件名。');
  }

  const now = new Date().toISOString();
  const id = generateId('inv');
  const fileId = file ? generateId('file') : undefined;

  const invoice: Invoice = {
    ...validated,
    id,
    createdAt: now,
    updatedAt: now,
    ...(fileId !== undefined ? { fileId } : {}),
  };

  try {
    await withTransaction(
      [STORE.invoices, STORE.invoiceFiles],
      'readwrite',
      (tx) => {
        tx.objectStore(STORE.invoices).put(invoice);
        if (file && fileId) {
          const record: InvoiceFile = {
            id: fileId,
            blob: file,
            mimeType: validated.mimeType,
            fileName: validated.fileName,
            size: file.size,
            createdAt: now,
          };
          tx.objectStore(STORE.invoiceFiles).put(record);
        }
      },
    );
  } catch (error) {
    throw wrapDbError(error, '保存发票失败');
  }

  return invoice;
}

/**
 * 更新发票字段：保留 id、fileId 与 createdAt，刷新 updatedAt。
 *
 * 采用「替换」语义：可选字段在输入中缺失即被清空，便于用户修正误识别内容。
 */
export async function updateInvoice(
  id: string,
  input: InvoiceInput,
): Promise<Invoice> {
  const validated = validateInvoiceInput(input);
  await assertTripExists(validated.tripId);

  const existing = await getInvoice(id);
  if (!existing) {
    throw new AppError('NOT_FOUND', '要更新的发票不存在，可能已被删除。');
  }

  const next: Invoice = {
    ...validated,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    ...(existing.fileId !== undefined ? { fileId: existing.fileId } : {}),
  };

  try {
    await withStore(STORE.invoices, 'readwrite', (store) => store.put(next));
  } catch (error) {
    throw wrapDbError(error, '更新发票失败');
  }

  return next;
}

/** 统计引用同一文件的发票数量。 */
export async function countInvoicesUsingFile(fileId: string): Promise<number> {
  try {
    return await countByIndex(STORE.invoices, 'by_fileId', fileId);
  } catch (error) {
    throw wrapDbError(error, '统计文件引用失败');
  }
}

/**
 * 删除发票。
 *
 * 若该发票关联的文件**没有**被其它发票引用，则在同一个事务中一并删除，
 * 避免遗留孤儿文件；若仍被引用则只删除本条元数据。
 */
export async function removeInvoice(id: string): Promise<void> {
  if (id.trim() === '') {
    throw new AppError('INVALID_ID', '发票 ID 不能为空。');
  }
  const existing = await getInvoice(id);
  if (!existing) {
    throw new AppError('NOT_FOUND', '要删除的发票不存在，可能已被删除。');
  }

  const fileId = existing.fileId;
  let shouldDeleteFile = false;
  if (fileId !== undefined) {
    const referencing = await countInvoicesUsingFile(fileId);
    shouldDeleteFile = referencing <= 1;
  }

  try {
    await withTransaction(
      [STORE.invoices, STORE.invoiceFiles],
      'readwrite',
      (tx) => {
        tx.objectStore(STORE.invoices).delete(id);
        if (shouldDeleteFile && fileId !== undefined) {
          tx.objectStore(STORE.invoiceFiles).delete(fileId);
        }
      },
    );
  } catch (error) {
    throw wrapDbError(error, '删除发票失败');
  }
}

/** 复制发票并替换其出差关联（传 undefined 表示解除关联）。 */
function withTripLink(invoice: Invoice, tripId: string | undefined): Invoice {
  return {
    id: invoice.id,
    category: invoice.category,
    status: invoice.status,
    fileName: invoice.fileName,
    mimeType: invoice.mimeType,
    size: invoice.size,
    source: invoice.source,
    createdAt: invoice.createdAt,
    updatedAt: new Date().toISOString(),
    ...(invoice.fileId !== undefined ? { fileId: invoice.fileId } : {}),
    ...(invoice.invoiceNumber !== undefined
      ? { invoiceNumber: invoice.invoiceNumber }
      : {}),
    ...(invoice.issuedAt !== undefined ? { issuedAt: invoice.issuedAt } : {}),
    ...(invoice.sellerName !== undefined ? { sellerName: invoice.sellerName } : {}),
    ...(invoice.amountCents !== undefined
      ? { amountCents: invoice.amountCents }
      : {}),
    ...(invoice.rawText !== undefined ? { rawText: invoice.rawText } : {}),
    ...(tripId !== undefined ? { tripId } : {}),
  };
}

/** 将发票关联到指定出差记录；出差不存在时拒绝。 */
export async function linkInvoiceToTrip(
  invoiceId: string,
  tripId: string,
): Promise<Invoice> {
  const trip = await getTrip(tripId);
  if (!trip) {
    throw new AppError(
      'INVALID_TRIP_LINK',
      '要关联的出差记录不存在，无法建立关联。',
    );
  }
  const existing = await getInvoice(invoiceId);
  if (!existing) {
    throw new AppError('NOT_FOUND', '要关联的发票不存在，可能已被删除。');
  }
  const next = withTripLink(existing, tripId);
  try {
    await withStore(STORE.invoices, 'readwrite', (store) => store.put(next));
  } catch (error) {
    throw wrapDbError(error, '关联发票失败');
  }
  return next;
}

/** 解除发票与出差记录的关联。 */
export async function unlinkInvoiceFromTrip(invoiceId: string): Promise<Invoice> {
  const existing = await getInvoice(invoiceId);
  if (!existing) {
    throw new AppError('NOT_FOUND', '要解除关联的发票不存在，可能已被删除。');
  }
  const next = withTripLink(existing, undefined);
  try {
    await withStore(STORE.invoices, 'readwrite', (store) => store.put(next));
  } catch (error) {
    throw wrapDbError(error, '解除关联失败');
  }
  return next;
}

/** 疑似重复发票及其判定依据。 */
export interface DuplicateCandidate {
  invoice: Invoice;
  reason: string;
}

/**
 * 查找疑似重复的发票（只做提示，绝不自动删除）。
 *
 * 优先以发票号码判断；缺少号码时退化为「日期 + 销售方 + 金额」完全相同。
 */
export async function findDuplicateCandidates(
  candidate: {
    invoiceNumber?: string | undefined;
    issuedAt?: string | undefined;
    sellerName?: string | undefined;
    amountCents?: Cents | undefined;
  },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const invoiceNumber = trimToUndefined(candidate.invoiceNumber);
  const issuedAt = trimToUndefined(candidate.issuedAt);
  const sellerName = trimToUndefined(candidate.sellerName);
  const amountCents = candidate.amountCents;

  if (
    invoiceNumber === undefined &&
    (issuedAt === undefined || sellerName === undefined || amountCents === undefined)
  ) {
    // 信息不足以做任何判断，不猜测。
    return [];
  }

  let all: Invoice[];
  try {
    all = await withStore<Invoice[]>(STORE.invoices, 'readonly', (store) =>
      store.getAll(),
    );
  } catch (error) {
    throw wrapDbError(error, '检查重复发票失败');
  }

  const results: DuplicateCandidate[] = [];
  for (const invoice of all) {
    if (excludeId !== undefined && invoice.id === excludeId) {
      continue;
    }
    if (
      invoiceNumber !== undefined &&
      trimToUndefined(invoice.invoiceNumber) === invoiceNumber
    ) {
      results.push({ invoice, reason: '发票号码相同' });
      continue;
    }
    if (
      issuedAt !== undefined &&
      sellerName !== undefined &&
      amountCents !== undefined &&
      invoice.issuedAt === issuedAt &&
      trimToUndefined(invoice.sellerName) === sellerName &&
      invoice.amountCents === amountCents
    ) {
      results.push({ invoice, reason: '开票日期、销售方与金额相同' });
    }
  }
  return results;
}
