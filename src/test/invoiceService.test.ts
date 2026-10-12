import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoice, InvoiceInput } from '../types';
import {
  DB_NAME,
  DB_VERSION,
  STORE,
  closeDatabase,
  deleteDatabase,
  withTransaction,
} from '../services/db';
import * as db from '../services/db';
import {
  createInvoice,
  findDuplicateCandidates,
  getInvoice,
  getInvoiceFile,
  linkInvoiceToTrip,
  listInvoices,
  removeInvoice,
  unlinkInvoiceFromTrip,
  updateInvoice,
} from '../services/invoiceService';
import { createTrip } from '../services/tripService';

vi.mock('../services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/db')>();
  return { ...actual, withTransaction: vi.fn(actual.withTransaction) };
});

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

/** 允许显式传 undefined 以测试「字段缺失」的场景（exactOptionalPropertyTypes）。 */
type InvoiceInputOverrides = {
  [K in keyof InvoiceInput]?: InvoiceInput[K] | undefined;
};

function makeInput(overrides: InvoiceInputOverrides = {}): InvoiceInput {
  const base: InvoiceInputOverrides = {
    invoiceNumber: '12345678',
    issuedAt: '2026-03-15',
    sellerName: '北京某某酒店管理有限公司',
    amountCents: 10600,
    category: 'accommodation',
    status: 'confirmed',
    fileName: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 12,
    source: 'pdf',
    ...overrides,
  };
  return {
    category: base.category ?? 'other',
    status: base.status ?? 'pending',
    fileName: base.fileName ?? '',
    mimeType: base.mimeType ?? '',
    size: base.size ?? 0,
    source: base.source ?? 'manual',
    ...(base.invoiceNumber !== undefined
      ? { invoiceNumber: base.invoiceNumber }
      : {}),
    ...(base.issuedAt !== undefined ? { issuedAt: base.issuedAt } : {}),
    ...(base.sellerName !== undefined ? { sellerName: base.sellerName } : {}),
    ...(base.amountCents !== undefined ? { amountCents: base.amountCents } : {}),
    ...(base.tripId !== undefined ? { tripId: base.tripId } : {}),
    ...(base.rawText !== undefined ? { rawText: base.rawText } : {}),
  };
}

function makeFile(content = 'INVOICE-BYTES'): Blob {
  return new Blob([content], { type: 'application/pdf' });
}

/**
 * 注意（测试环境限制）：
 * fake-indexeddb 不会像真实浏览器那样按结构化克隆保存 Blob，读回的 blob 是普通对象，
 * 因此这里只校验「文件记录存在 + 元数据正确 + 与发票的 fileId 对应」。
 * 真实浏览器中的 Blob 内容往返由 IndexedDB 原生保证。
 */
function expectFileRecordMatches(
  record: { fileName: string; mimeType: string; size: number; blob: unknown } | null,
  source: Blob,
): void {
  expect(record).not.toBeNull();
  expect(record?.fileName).toBe('invoice.pdf');
  expect(record?.mimeType).toBe('application/pdf');
  expect(record?.size).toBe(source.size);
  expect(record?.blob).toBeTruthy();
}

describe('invoiceService（IndexedDB）', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    vi.mocked(db.withTransaction).mockClear();
    await resetDatabase();
  });

  it('新建、查询、更新和删除发票', async () => {
    const created = await createInvoice(makeInput());
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();

    expect(await listInvoices()).toHaveLength(1);
    expect((await getInvoice(created.id))?.invoiceNumber).toBe('12345678');

    const updated = await updateInvoice(created.id, {
      ...makeInput(),
      sellerName: '上海某某酒店有限公司',
      amountCents: 20000,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.sellerName).toBe('上海某某酒店有限公司');
    expect(updated.amountCents).toBe(20000);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    await removeInvoice(created.id);
    expect(await getInvoice(created.id)).toBeNull();
    expect(await listInvoices()).toHaveLength(0);
  });

  it('查询不存在的发票返回 null，删除/更新不存在的发票明确报错', async () => {
    expect(await getInvoice('missing')).toBeNull();
    await expect(removeInvoice('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(updateInvoice('missing', makeInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('保存 PDF 文件后能够重新读取，且发票通过 fileId 关联到文件记录', async () => {
    const file = makeFile('PDF-CONTENT-1');
    const created = await createInvoice(makeInput(), file);
    expect(created.fileId).toBeTruthy();

    const stored = await getInvoiceFile(created.fileId ?? '');
    expectFileRecordMatches(stored, file);

    // 关联是双向可验证的：发票 -> fileId -> 文件记录
    const reloaded = await getInvoice(created.id);
    expect(reloaded?.fileId).toBe(created.fileId);
  });

  it('手工录入（无文件）时不产生 fileId，也不会创建空文件记录', async () => {
    const created = await createInvoice(
      makeInput({ source: 'manual', fileName: '', mimeType: '', size: 0 }),
    );
    expect(created.fileId).toBeUndefined();
    const allFiles = await db.withStore<unknown[]>(
      STORE.invoiceFiles,
      'readonly',
      (store) => store.getAll(),
    );
    expect(allFiles).toHaveLength(0);
  });

  it('按类别、出差 ID 与状态查询', async () => {
    const trip = await createTrip({
      name: '上海出差',
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    await createInvoice(makeInput({ category: 'meal', status: 'pending' }));
    await createInvoice(
      makeInput({
        invoiceNumber: '22222222',
        category: 'transport',
        status: 'confirmed',
        tripId: trip.id,
      }),
    );

    expect(await listInvoices({ category: 'meal' })).toHaveLength(1);
    expect(await listInvoices({ status: 'pending' })).toHaveLength(1);
    expect(await listInvoices({ tripId: trip.id })).toHaveLength(1);
    expect(
      await listInvoices({ category: 'transport', status: 'confirmed' }),
    ).toHaveLength(1);
    expect(await listInvoices({ category: 'other' })).toHaveLength(0);
  });

  it('金额缺失时保持 undefined，且不能标记为已确认', async () => {
    const pending = await createInvoice(
      makeInput({ amountCents: undefined, status: 'pending' }),
    );
    expect(pending.amountCents).toBeUndefined();
    // 绝不是被静默转换成 0 元
    expect(pending.amountCents).not.toBe(0);

    await expect(
      createInvoice(makeInput({ amountCents: undefined, status: 'confirmed' })),
    ).rejects.toMatchObject({ code: 'AMOUNT_REQUIRED' });
  });

  it('拒绝非法输入', async () => {
    await expect(
      createInvoice(makeInput({ amountCents: -1 })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(
      createInvoice(makeInput({ amountCents: 10.5 })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(
      createInvoice(makeInput({ issuedAt: '2026-13-45' })),
    ).rejects.toMatchObject({ code: 'INVALID_DATE' });
  });

  it('关联与解除关联真正写入数据库', async () => {
    const trip = await createTrip({
      name: '北京出差',
      startDate: '2026-03-01',
      endDate: '2026-03-02',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    const invoice = await createInvoice(makeInput());

    const linked = await linkInvoiceToTrip(invoice.id, trip.id);
    expect(linked.tripId).toBe(trip.id);
    // 重新从数据库读取，确认已持久化
    expect((await getInvoice(invoice.id))?.tripId).toBe(trip.id);
    expect(await listInvoices({ tripId: trip.id })).toHaveLength(1);

    const unlinked = await unlinkInvoiceFromTrip(invoice.id);
    expect(unlinked.tripId).toBeUndefined();
    expect((await getInvoice(invoice.id))?.tripId).toBeUndefined();
    expect(await listInvoices({ tripId: trip.id })).toHaveLength(0);
  });

  it('拒绝关联不存在的出差记录', async () => {
    const invoice = await createInvoice(makeInput());
    await expect(
      linkInvoiceToTrip(invoice.id, 'missing-trip'),
    ).rejects.toMatchObject({ code: 'INVALID_TRIP_LINK' });
    await expect(
      createInvoice(makeInput({ tripId: 'missing-trip' })),
    ).rejects.toMatchObject({ code: 'INVALID_TRIP_LINK' });
    // 无效关联不会留下半条记录
    expect(await listInvoices()).toHaveLength(1);
  });

  it('删除发票时清理不再被引用的文件', async () => {
    const created = await createInvoice(makeInput(), makeFile());
    const fileId = created.fileId ?? '';
    expect(await getInvoiceFile(fileId)).not.toBeNull();

    await removeInvoice(created.id);
    expect(await getInvoiceFile(fileId)).toBeNull();
  });

  it('文件仍被其它记录引用时不会被删除', async () => {
    const first = await createInvoice(makeInput(), makeFile('SHARED'));
    const fileId = first.fileId ?? '';

    // 直接构造第二条发票共用同一文件，验证引用计数逻辑。
    const second: Invoice = {
      ...first,
      id: 'inv-second',
      invoiceNumber: '99999999',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await withTransaction([STORE.invoices], 'readwrite', (tx) => {
      tx.objectStore(STORE.invoices).put(second);
    });

    await removeInvoice(first.id);
    // 仍被 second 引用，文件必须保留
    expect(await getInvoiceFile(fileId)).not.toBeNull();

    await removeInvoice(second.id);
    expect(await getInvoiceFile(fileId)).toBeNull();
  });

  it('元数据与文件写入失败时整体回滚，不出现半条数据', async () => {
    vi.mocked(db.withTransaction).mockRejectedValueOnce(
      new Error('模拟事务失败'),
    );

    await expect(
      createInvoice(makeInput(), makeFile()),
    ).rejects.toMatchObject({ code: 'DB_ERROR' });

    // 元数据与文件都不应存在：页面不会看到「保存成功但文件缺失」的假象。
    expect(await listInvoices()).toHaveLength(0);
    const allFiles = await db.withStore<unknown[]>(
      STORE.invoiceFiles,
      'readonly',
      (store) => store.getAll(),
    );
    expect(allFiles).toHaveLength(0);
  });

  it('IndexedDB 不可用时返回可读错误', async () => {
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
    });
    try {
      await expect(listInvoices()).rejects.toMatchObject({ code: 'DB_ERROR' });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
      });
    }
  });

  it('疑似重复发票按发票号码判断，且不会自动删除', async () => {
    await createInvoice(makeInput({ invoiceNumber: '12345678' }));

    const byNumber = await findDuplicateCandidates({ invoiceNumber: '12345678' });
    expect(byNumber).toHaveLength(1);
    expect(byNumber[0]?.reason).toBe('发票号码相同');

    // 排除自身后不再命中
    const created = await createInvoice(makeInput({ invoiceNumber: '12345678' }));
    expect(
      await findDuplicateCandidates({ invoiceNumber: '12345678' }, created.id),
    ).toHaveLength(1);

    // 信息不足时不猜测
    expect(await findDuplicateCandidates({})).toEqual([]);
    // 重复提示不会删除任何数据
    expect(await listInvoices()).toHaveLength(2);
  });

  it('缺少发票号码时按日期、销售方与金额提示疑似重复', async () => {
    await createInvoice(makeInput({ invoiceNumber: undefined }));
    const candidates = await findDuplicateCandidates({
      issuedAt: '2026-03-15',
      sellerName: '北京某某酒店管理有限公司',
      amountCents: 10600,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.reason).toBe('开票日期、销售方与金额相同');
  });
});

/** 版本 1 的发票结构（没有 category / status 字段）。 */
interface LegacyV1Invoice {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  source: string;
  amountCents?: number;
  issuedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 构造一个真实的 v1 数据库并写入一条旧数据，然后关闭连接。 */
async function seedLegacyV1Database(legacy: LegacyV1Invoice): Promise<void> {
  await closeDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      const trips = database.createObjectStore(STORE.trips, { keyPath: 'id' });
      trips.createIndex('by_startDate', 'startDate', { unique: false });
      const invoices = database.createObjectStore(STORE.invoices, { keyPath: 'id' });
      invoices.createIndex('by_tripId', 'tripId', { unique: false });
      invoices.createIndex('by_issuedAt', 'issuedAt', { unique: false });
      database.createObjectStore(STORE.invoiceFiles, { keyPath: 'id' });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('升级被阻塞'));
    request.onsuccess = () => {
      const database = request.result;
      const tx = database.transaction([STORE.invoices], 'readwrite');
      tx.objectStore(STORE.invoices).put(legacy);
      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe('数据库迁移（v1 → v2）', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('升级后旧数据仍可读取，并新增了索引', async () => {
    const legacy: LegacyV1Invoice = {
      id: 'legacy-1',
      fileName: 'legacy.pdf',
      mimeType: 'application/pdf',
      size: 10,
      source: 'pdf',
      amountCents: 5000,
      issuedAt: '2025-12-01',
      createdAt: '2025-12-01T00:00:00.000Z',
      updatedAt: '2025-12-01T00:00:00.000Z',
    };
    await seedLegacyV1Database(legacy);

    // 通过应用服务打开数据库，应触发 v1 → v2 升级。
    const all = await listInvoices();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('legacy-1');
    expect(all[0]?.amountCents).toBe(5000);

    // 旧数据没有 category/status，但新索引必须已存在且可查询（不抛错）。
    expect(await listInvoices({ category: 'meal' })).toHaveLength(0);
    expect(await listInvoices({ status: 'confirmed' })).toHaveLength(0);

    const database = await db.openDatabase();
    expect(database.version).toBe(DB_VERSION);
    const tx = database.transaction(STORE.invoices, 'readonly');
    const indexNames = tx.objectStore(STORE.invoices).indexNames;
    expect(indexNames.contains('by_category')).toBe(true);
    expect(indexNames.contains('by_status')).toBe(true);
    expect(indexNames.contains('by_fileId')).toBe(true);
    expect(indexNames.contains('by_tripId')).toBe(true);
  });
});
