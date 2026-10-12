import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import InvoiceForm from '../features/invoices/InvoiceForm';
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
} from '../features/invoices/invoiceLabels';
import { useInvoices } from '../features/invoices/useInvoices';
import type { InvoiceFormFields, InvoiceFormValues } from '../features/invoices/invoiceFormValidation';
import { useTrips } from '../features/trips/useTrips';
import type {
  Invoice,
  InvoiceCategory,
  InvoiceFieldName,
  InvoiceInput,
  InvoiceSource,
  InvoiceStatus,
} from '../types';
import { INVOICE_CATEGORIES, INVOICE_STATUSES } from '../types';
import { formatCents, formatCentsAsYuan } from '../utils/budget';
import { formatDisplayDate } from '../utils/date';
import { toErrorInfo } from '../utils/errors';
import { parseInvoiceText } from '../utils/invoiceParser';
import {
  createInvoice,
  findDuplicateCandidates,
  linkInvoiceToTrip,
  removeInvoice,
  unlinkInvoiceFromTrip,
  updateInvoice,
  type DuplicateCandidate,
  type InvoiceQuery,
} from '../services/invoiceService';
import {
  isConfirmedLinkedMealInvoice,
  sumInvoiceAmount,
  summarizeInvoiceCategories,
} from '../services/budgetService';


/** 新建/编辑发票时，与用户输入无关的来源信息。 */
interface InvoiceSourceContext {
  fileName: string;
  mimeType: string;
  size: number;
  source: InvoiceSource;
}

interface FormSession {
  mode: 'create' | 'edit';
  invoiceId?: string;
  title: string;
  submitLabel: string;
  values: InvoiceFormValues;
  reviewFields: InvoiceFieldName[];
  notice?: ReactNode;
  rawText?: string;
  /** 新建时待保存的 PDF；手工录入为空。 */
  file?: Blob;
  context: InvoiceSourceContext;
}

interface ManualPrompt {
  message: string;
  tone: 'warn' | 'error';
  fileName: string;
  /** 解析成功但没有文本时仍保留文件，便于与手工录入结果一起保存。 */
  file?: Blob;
}

/** 发票管理页：上传解析、核对保存、手动录入、筛选、关联与删除。 */
export default function Invoices() {
  const [categoryFilter, setCategoryFilter] = useState<InvoiceCategory | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | 'all'>('all');

  const query: InvoiceQuery = useMemo(() => {
    const result: InvoiceQuery = {};
    if (categoryFilter !== 'all') {
      result.category = categoryFilter;
    }
    if (statusFilter !== 'all') {
      result.status = statusFilter;
    }
    return result;
  }, [categoryFilter, statusFilter]);

  const filterKey = `${categoryFilter}/${statusFilter}`;
  const { invoices, loading, error, reload } = useInvoices(query, filterKey);
  const { trips } = useTrips();
  const tripNames = useMemo(
    () => new Map(trips.map((trip) => [trip.id, trip.name])),
    [trips],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [manualPrompt, setManualPrompt] = useState<ManualPrompt | null>(null);
  const [session, setSession] = useState<FormSession | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingDuplicate, setPendingDuplicate] = useState<{
    fields: InvoiceFormFields;
    candidates: DuplicateCandidate[];
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Invoice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const closeForm = useCallback(() => {
    setSession(null);
    setSubmitError(null);
    setPendingDuplicate(null);
  }, []);

  /** 处理上传：本地提取文本 → 解析 → 进入核对表单。 */
  const handleFile = useCallback(async (file: File) => {
    setActionError(null);
    setManualPrompt(null);
    setSession(null);
    setParsing(true);
    try {
      // PDF.js 体积较大，仅在真正需要解析时按需加载，避免拖慢首屏。
      const { extractPdfText } = await import('../services/pdfService');
      const extracted = await extractPdfText(file);
      if (!extracted.hasText) {
        // 扫描版或纯图片 PDF：不自动识别，引导手动录入。
        setManualPrompt({
          tone: 'warn',
          fileName: file.name,
          file,
          message:
            '该 PDF 未包含可提取的文本（可能是扫描件或图片型发票），当前版本暂不支持自动识别，请手动录入。文件仍会作为附件保存。',
        });
        return;
      }

      const parsed = parseInvoiceText(extracted.text);
      setSession({
        mode: 'create',
        title: '核对识别结果',
        submitLabel: '保存',
        reviewFields: parsed.needsReview,
        notice:
          `识别状态：${parseStatusLabel(parsed.status)}。${parsed.message}` +
          '核对无误后请把「识别状态」改为「已确认」再保存；未标记为已确认的发票不计入金额合计。',
        rawText: extracted.text,
        file,
        context: {
          fileName: file.name,
          mimeType: file.type || 'application/pdf',
          size: file.size,
          source: 'pdf',
        },
        values: {
          invoiceNumber: parsed.fields.invoiceNumber ?? '',
          issuedAt: parsed.fields.issuedAt ?? '',
          sellerName: parsed.fields.sellerName ?? '',
          amountYuan:
            parsed.fields.totalCents !== undefined
              ? formatCentsAsYuan(parsed.fields.totalCents)
              : '',
          category: 'other',
          status: parsed.status === 'unrecognized' ? 'failed' : 'pending',
          tripId: '',
        },
      });
    } catch (err) {
      setManualPrompt({
        tone: 'error',
        fileName: file.name,
        message: `无法解析该 PDF：${toErrorInfo(err).message}。已跳过附件保存，可改为手动录入。`,
      });
    } finally {
      setParsing(false);
    }
  }, []);

  const handleManualEntry = useCallback(() => {
    const file = manualPrompt?.file;
    setManualPrompt(null);
    setSubmitError(null);
    setSession({
      mode: 'create',
      title: '手动录入发票',
      submitLabel: '保存发票',
      reviewFields: ['invoiceNumber', 'issuedAt', 'sellerName', 'totalCents'],
      notice: file
        ? `将附件「${manualPrompt?.fileName ?? ''}」与手工录入的字段一起保存。`
        : '当前为手动录入，未关联任何文件。',
      ...(file ? { file } : {}),
      context: file
        ? {
            fileName: manualPrompt?.fileName ?? '',
            mimeType: file.type || 'application/pdf',
            size: file.size,
            source: 'pdf',
          }
        : { fileName: '', mimeType: '', size: 0, source: 'manual' },
      values: {
        invoiceNumber: '',
        issuedAt: '',
        sellerName: '',
        amountYuan: '',
        category: 'other',
        status: 'pending',
        tripId: '',
      },
    });
  }, [manualPrompt]);

  const handleEdit = useCallback((invoice: Invoice) => {
    setSubmitError(null);
    setSession({
      mode: 'edit',
      invoiceId: invoice.id,
      title: '编辑发票',
      submitLabel: '保存修改',
      reviewFields: [],
      ...(invoice.rawText !== undefined ? { rawText: invoice.rawText } : {}),
      context: {
        fileName: invoice.fileName,
        mimeType: invoice.mimeType,
        size: invoice.size,
        source: invoice.source,
      },
      values: {
        invoiceNumber: invoice.invoiceNumber ?? '',
        issuedAt: invoice.issuedAt ?? '',
        sellerName: invoice.sellerName ?? '',
        amountYuan:
          invoice.amountCents !== undefined
            ? formatCentsAsYuan(invoice.amountCents)
            : '',
        category: invoice.category,
        status: invoice.status,
        tripId: invoice.tripId ?? '',
      },
    });
  }, []);

  /** 真正写库：新建时附带 PDF，编辑时更新字段。 */
  const persist = useCallback(
    async (fields: InvoiceFormFields) => {
      if (!session) {
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const input: InvoiceInput = {
          ...session.context,
          category: fields.category,
          status: fields.status,
          ...(fields.invoiceNumber !== undefined
            ? { invoiceNumber: fields.invoiceNumber }
            : {}),
          ...(fields.issuedAt !== undefined ? { issuedAt: fields.issuedAt } : {}),
          ...(fields.sellerName !== undefined
            ? { sellerName: fields.sellerName }
            : {}),
          ...(fields.amountCents !== undefined
            ? { amountCents: fields.amountCents }
            : {}),
          ...(fields.tripId !== undefined ? { tripId: fields.tripId } : {}),
          ...(session.rawText !== undefined ? { rawText: session.rawText } : {}),
        };

        if (session.mode === 'edit' && session.invoiceId !== undefined) {
          await updateInvoice(session.invoiceId, input);
        } else if (session.file) {
          await createInvoice(input, session.file);
        } else {
          await createInvoice(input);
        }
        // 保存成功后重新读取数据库，页面展示持久化后的真实数据。
        await reload();
        closeForm();
      } catch (err) {
        setSubmitError(toErrorInfo(err).message);
      } finally {
        setSubmitting(false);
      }
    },
    [session, reload, closeForm],
  );

  const handleSubmit = useCallback(
    async (fields: InvoiceFormFields) => {
      setSubmitError(null);
      try {
        const candidates = await findDuplicateCandidates(
          {
            invoiceNumber: fields.invoiceNumber,
            issuedAt: fields.issuedAt,
            sellerName: fields.sellerName,
            amountCents: fields.amountCents,
          },
          session?.invoiceId,
        );
        if (candidates.length > 0) {
          // 只提示，不自动处理；由用户决定是否继续保存。
          setPendingDuplicate({ fields, candidates });
          return;
        }
      } catch (err) {
        setSubmitError(toErrorInfo(err).message);
        return;
      }
      await persist(fields);
    },
    [session, persist],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return;
    }
    setActionError(null);
    try {
      await removeInvoice(pendingDelete.id);
      await reload();
      setPendingDelete(null);
    } catch (err) {
      setActionError(toErrorInfo(err).message);
      setPendingDelete(null);
    }
  }, [pendingDelete, reload]);

  const handleUnlink = useCallback(
    async (invoice: Invoice) => {
      setActionError(null);
      try {
        await unlinkInvoiceFromTrip(invoice.id);
        await reload();
      } catch (err) {
        setActionError(toErrorInfo(err).message);
      }
    },
    [reload],
  );

  /** 快速关联：把发票挂到最近的出差记录上（无出差时提示）。 */
  const handleQuickLink = useCallback(
    async (invoice: Invoice) => {
      const firstTrip = trips[0];
      if (!firstTrip) {
        setActionError('暂无出差记录，无法关联。请先在「出差」中创建记录。');
        return;
      }
      setActionError(null);
      try {
        await linkInvoiceToTrip(invoice.id, firstTrip.id);
        await reload();
      } catch (err) {
        setActionError(toErrorInfo(err).message);
      }
    },
    [trips, reload],
  );

  // 三个口径都由服务层统一筛选求和，避免页面各自实现一套规则。
  // 统计范围 = 上方筛选后的结果，页面上会明确说明。
  const confirmedTotal = sumInvoiceAmount(
    invoices,
    (invoice) => invoice.status === 'confirmed',
  );
  const mealLinkedTotal = sumInvoiceAmount(invoices, isConfirmedLinkedMealInvoice);
  const pendingTotal = sumInvoiceAmount(
    invoices,
    (invoice) => invoice.status === 'pending',
  );
  // 分类汇总：按类别拆分已确认金额与数量，待核对/识别失败单独计数。
  const categoryBreakdown = summarizeInvoiceCategories(invoices);

  return (
    <section className="page">
      <div className="card">
        <h2 className="card__title">导入发票</h2>
        <p className="page__meta">
          选择 PDF 后在本地解析，文件与识别结果都只保存在这台设备上。
        </p>
        <input
          ref={fileInputRef}
          className="form__input"
          type="file"
          accept="application/pdf,.pdf"
          aria-label="选择 PDF 发票"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // 重置以便再次选择同一个文件时仍能触发。
            event.target.value = '';
            if (file) {
              void handleFile(file);
            }
          }}
        />
        {parsing ? (
          <p className="page__meta" role="status">
            正在本地解析 PDF…
          </p>
        ) : null}
        <div className="form__actions">
          <button type="button" className="btn" onClick={handleManualEntry}>
            手动新增发票
          </button>
        </div>
      </div>

      {actionError ? (
        <p className="form__error form__error--block" role="alert">
          {actionError}
        </p>
      ) : null}

      {manualPrompt ? (
        <div className="alert alert--warn" role="alert">
          <p>{manualPrompt.message}</p>
          <div className="form__actions">
            <button type="button" className="btn btn--primary" onClick={handleManualEntry}>
              手动录入
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setManualPrompt(null)}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {pendingDuplicate ? (
        <div className="alert alert--warn" role="alert">
          <p>
            检测到 {pendingDuplicate.candidates.length} 条疑似重复发票，请确认是否继续保存：
          </p>
          <ul className="duplicate-list">
            {pendingDuplicate.candidates.map((candidate) => (
              <li key={candidate.invoice.id}>
                {candidate.invoice.fileName} · {candidate.reason}
                {candidate.invoice.issuedAt
                  ? ` · ${formatDisplayDate(candidate.invoice.issuedAt)}`
                  : ''}
              </li>
            ))}
          </ul>
          <div className="form__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={submitting}
              onClick={() => {
                const fields = pendingDuplicate.fields;
                setPendingDuplicate(null);
                void persist(fields);
              }}
            >
              仍然保存
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setPendingDuplicate(null)}
            >
              返回修改
            </button>
          </div>
        </div>
      ) : null}

      {session ? (
        <InvoiceForm
          key={`${session.mode}-${session.invoiceId ?? 'new'}-${session.rawText ?? ''}`}
          title={session.title}
          initialValues={session.values}
          trips={trips}
          submitLabel={session.submitLabel}
          reviewFields={session.reviewFields}
          {...(session.notice !== undefined ? { notice: session.notice } : {})}
          {...(session.rawText !== undefined ? { rawText: session.rawText } : {})}
          submitError={submitError}
          submitting={submitting}
          onSubmit={(fields) => void handleSubmit(fields)}
          onCancel={closeForm}
        />
      ) : null}

      <div className="stat-card">
        <p className="stat-card__label">已确认金额合计</p>
        <p className="stat-card__value">{formatCents(confirmedTotal)}</p>
        <p className="page__meta">
          统计范围：上方筛选结果中状态为「已确认」且已填写金额的发票。
          待核对与识别失败的发票不计入，住宿 / 交通 / 其他类别同样不会计入任何出差的餐补。
        </p>
        <dl className="detail-list">
          <div className="detail-list__row">
            <dt>其中：已关联出差的餐饮发票（可计入对应出差餐补）</dt>
            <dd>{formatCents(mealLinkedTotal)}</dd>
          </div>
          <div className="detail-list__row">
            <dt>待核对发票金额（不计入合计）</dt>
            <dd>{formatCents(pendingTotal)}</dd>
          </div>
        </dl>
      </div>

      <div className="stat-card">
        <h2 className="card__title">发票分类汇总</h2>
        <p className="page__meta">
          以下按类别拆分「已确认」发票的金额与数量，所有类别合计应等于上方「已确认金额合计」；
          待核对与识别失败只统计数量、不计入金额。
        </p>
        <dl className="detail-list">
          {categoryBreakdown.byCategory.map((entry) => (
            <div className="detail-list__row" key={entry.category}>
              <dt>
                {CATEGORY_LABELS[entry.category]}（{entry.confirmedCount} 张）
              </dt>
              <dd>{formatCents(entry.confirmedCents)}</dd>
            </div>
          ))}
          <div className="detail-list__row">
            <dt>待核对发票</dt>
            <dd>{categoryBreakdown.pendingCount} 张</dd>
          </div>
          <div className="detail-list__row">
            <dt>识别失败发票</dt>
            <dd>{categoryBreakdown.failedCount} 张</dd>
          </div>
        </dl>
      </div>

      <div className="filter-group">
        <div className="chip-row" role="group" aria-label="按类别筛选">
          <FilterChip
            label="全部类别"
            active={categoryFilter === 'all'}
            onClick={() => setCategoryFilter('all')}
          />
          {INVOICE_CATEGORIES.map((category) => (
            <FilterChip
              key={category}
              label={CATEGORY_LABELS[category]}
              active={categoryFilter === category}
              onClick={() => setCategoryFilter(category)}
            />
          ))}
        </div>
        <div className="chip-row" role="group" aria-label="按状态筛选">
          <FilterChip
            label="全部状态"
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          />
          {INVOICE_STATUSES.map((status) => (
            <FilterChip
              key={status}
              label={STATUS_LABELS[status]}
              active={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            />
          ))}
        </div>
      </div>

      {loading ? <p className="page__meta">正在读取本地数据…</p> : null}

      {!loading && error ? (
        <div className="card">
          <p className="form__error" role="alert">
            读取发票失败：{error}
          </p>
          <button type="button" className="btn" onClick={() => void reload()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !error && invoices.length === 0 ? (
        <EmptyState
          title="还没有发票"
          description="上传 PDF 发票或手动新增一条；所有数据只保存在本机浏览器。"
        />
      ) : null}

      {!loading && !error && invoices.length > 0 ? (
        <ul className="invoice-list">
          {invoices.map((invoice) => (
            <InvoiceItem
              key={invoice.id}
              invoice={invoice}
              tripName={
                invoice.tripId !== undefined ? tripNames.get(invoice.tripId) : undefined
              }
              onEdit={() => handleEdit(invoice)}
              onDelete={() => setPendingDelete(invoice)}
              onUnlink={() => void handleUnlink(invoice)}
              onQuickLink={() => void handleQuickLink(invoice)}
            />
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除发票"
        description={
          pendingDelete
            ? `确认删除「${pendingDelete.fileName || '未命名发票'}」？关联的文件若不再被其它发票使用也会一并清理。`
            : ''
        }
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

function parseStatusLabel(status: 'parsed' | 'partial' | 'unrecognized'): string {
  if (status === 'parsed') {
    return '识别成功';
  }
  if (status === 'partial') {
    return '部分识别';
  }
  return '识别失败';
}

interface FilterChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function FilterChip({ label, active, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      className={active ? 'chip chip--active' : 'chip'}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

interface InvoiceItemProps {
  invoice: Invoice;
  tripName: string | undefined;
  onEdit: () => void;
  onDelete: () => void;
  onUnlink: () => void;
  onQuickLink: () => void;
}

function InvoiceItem({
  invoice,
  tripName,
  onEdit,
  onDelete,
  onUnlink,
  onQuickLink,
}: InvoiceItemProps) {
  return (
    <li className="card invoice-item">
      <div className="invoice-item__head">
        <span className="invoice-item__title">
          {invoice.invoiceNumber ?? '未识别发票号码'}
        </span>
        <span className={`badge badge--${invoice.status}`}>
          {STATUS_LABELS[invoice.status]}
        </span>
      </div>

      <p className="page__meta">
        {CATEGORY_LABELS[invoice.category]} ·{' '}
        {invoice.issuedAt ? formatDisplayDate(invoice.issuedAt) : '日期未填写'}
      </p>
      <p className="page__meta">
        {invoice.sellerName !== undefined ? invoice.sellerName : '销售方未填写'}
      </p>
      <p className="invoice-item__amount">
        {invoice.amountCents !== undefined
          ? formatCents(invoice.amountCents)
          : '金额未填写（不计入合计）'}
      </p>
      <p className="page__meta">
        {tripName !== undefined ? `已关联出差：${tripName}` : '未关联出差'}
      </p>
      <p className="page__meta">
        {invoice.fileName !== '' ? `附件：${invoice.fileName}` : '无附件'}
      </p>

      <div className="trip-item__actions">
        <button type="button" className="btn" onClick={onEdit}>
          编辑
        </button>
        {invoice.tripId !== undefined ? (
          <button type="button" className="btn" onClick={onUnlink}>
            解除关联
          </button>
        ) : (
          <button type="button" className="btn" onClick={onQuickLink}>
            关联出差
          </button>
        )}
        <button type="button" className="btn btn--danger" onClick={onDelete}>
          删除
        </button>
      </div>
    </li>
  );
}
