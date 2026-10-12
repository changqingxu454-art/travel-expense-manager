import { useCallback, useEffect, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import { useMealUsage } from '../features/budget/useMealUsage';
import { STATUS_LABELS } from '../features/invoices/invoiceLabels';
import TripBudgetSummary from '../features/trips/TripBudgetSummary';
import TripForm from '../features/trips/TripForm';
import { formatCents } from '../utils/budget';
import { formatDisplayDate } from '../utils/date';
import { toErrorInfo } from '../utils/errors';
import type { Invoice, Trip, TripInput } from '../types';
import { countsTowardMealUsage } from '../services/budgetService';
import { listInvoices } from '../services/invoiceService';
import { getTrip, removeTrip, updateTrip } from '../services/tripService';

interface TripDetailProps {
  /** 路由中的出差记录 id。 */
  tripId: string;
}

type LoadState = 'loading' | 'found' | 'missing' | 'error';

/** 出差详情页：展示完整信息、餐补额度，并提供编辑与删除入口。 */
export default function TripDetail({ tripId }: TripDetailProps) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(true);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  const {
    summary: mealUsage,
    loading: usageLoading,
    error: usageError,
    reload: reloadUsage,
  } = useMealUsage(tripId);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const found = await getTrip(tripId);
      if (!found) {
        setTrip(null);
        setState('missing');
        return;
      }
      setTrip(found);
      setState('found');
    } catch (err) {
      setTrip(null);
      setError(toErrorInfo(err).message);
      setState('error');
    }
  }, [tripId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const data = await listInvoices({ tripId });
      setInvoices(data);
      setInvoiceError(null);
    } catch (err) {
      setInvoices([]);
      setInvoiceError(toErrorInfo(err).message);
    } finally {
      setInvoicesLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    void loadInvoices();
  }, [loadInvoices]);

  const handleSubmit = useCallback(
    async (input: TripInput) => {
      await updateTrip(tripId, input);
      await load();
      // 出差日期 / 每日餐数 / 每餐标准变化后，餐补预算随之变化，必须重新统计。
      await reloadUsage();
      setEditing(false);
    },
    [tripId, load, reloadUsage],
  );

  /** 重新读取页面上的全部真实数据（记录、关联发票、餐补统计）。 */
  const reloadAll = useCallback(async () => {
    await Promise.all([load(), loadInvoices(), reloadUsage()]);
  }, [load, loadInvoices, reloadUsage]);

  const confirmDelete = useCallback(async () => {
    setActionError(null);
    try {
      await removeTrip(tripId);
      window.location.hash = '#/trips';
    } catch (err) {
      setActionError(toErrorInfo(err).message);
      setConfirmingDelete(false);
    }
  }, [tripId]);

  if (state === 'loading') {
    return (
      <section className="page">
        <p className="page__meta">正在读取本地数据…</p>
      </section>
    );
  }

  if (state === 'missing') {
    return (
      <section className="page">
        <EmptyState
          title="出差记录不存在"
          description="该记录可能已被删除。"
          action={
            <a className="btn btn--primary" href="#/trips">
              返回列表
            </a>
          }
        />
      </section>
    );
  }

  if (state === 'error' || !trip) {
    return (
      <section className="page">
        <p className="form__error form__error--block" role="alert">
          读取出差记录失败：{error ?? '未知错误'}
        </p>
        <button type="button" className="btn" onClick={() => void reloadAll()}>
          重试
        </button>
      </section>
    );
  }

  // 餐补统计仍在读取时先显示加载态，避免先展示「已使用 0 元」的假数据。
  // 编辑表单打开时不拦截，避免保存过程中的重新统计把表单闪掉。
  if (usageLoading && !editing) {
    return (
      <section className="page">
        <p className="page__meta">正在读取本地数据…</p>
      </section>
    );
  }

  return (
    <section className="page">
      <a className="page__meta" href="#/trips">
        ← 返回出差列表
      </a>

      {actionError ? (
        <p className="form__error form__error--block" role="alert">
          {actionError}
        </p>
      ) : null}

      {editing ? (
        <TripForm
          trip={trip}
          onSubmit={handleSubmit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="card">
            <h2 className="card__title">{trip.name}</h2>
            <dl className="detail-list">
              <div className="detail-list__row">
                <dt>开始日期</dt>
                <dd>{formatDisplayDate(trip.startDate)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>结束日期</dt>
                <dd>{formatDisplayDate(trip.endDate)}</dd>
              </div>
              <div className="detail-list__row">
                <dt>每日餐数</dt>
                <dd>{trip.mealsPerDay} 餐</dd>
              </div>
              <div className="detail-list__row">
                <dt>每餐标准</dt>
                <dd>{formatCents(trip.mealStandardCents)}</dd>
              </div>
            </dl>
          </div>

          <div className="card">
            <h2 className="card__title">餐补预算</h2>
            <TripBudgetSummary
              trip={trip}
              {...(mealUsage !== null ? { usedCents: mealUsage.usedCents } : {})}
              error={usageError}
            />
            <p className="page__meta">
              已使用金额只统计「已确认」、类别为「餐饮」且已关联本次出差的发票；
              待核对、识别失败、其它类别以及未关联或关联到别的出差的发票都不计入。
            </p>
          </div>

          <div className="card">
            <h2 className="card__title">关联发票</h2>
            {invoicesLoading ? (
              <p className="page__meta">正在读取本地数据…</p>
            ) : null}
            {!invoicesLoading && invoiceError ? (
              <div>
                <p className="form__error" role="alert">
                  读取关联发票失败：{invoiceError}
                </p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadInvoices()}
                >
                  重试
                </button>
              </div>
            ) : null}
            {!invoicesLoading && !invoiceError && invoices.length === 0 ? (
              <p className="page__meta">
                该出差还没有关联发票，可在「发票」页选择后关联。
              </p>
            ) : null}
            {!invoicesLoading && !invoiceError && invoices.length > 0 ? (
              <ul className="invoice-list">
                {invoices.map((invoice) => (
                  <li key={invoice.id} className="invoice-item">
                    <div className="invoice-item__head">
                      <span className="invoice-item__title">
                        {invoice.invoiceNumber ?? '未识别发票号码'}
                      </span>
                      <span className={`badge badge--${invoice.status}`}>
                        {STATUS_LABELS[invoice.status]}
                      </span>
                    </div>
                    <p className="page__meta">
                      {invoice.sellerName ?? '销售方未填写'}
                      {invoice.issuedAt
                        ? ` · ${formatDisplayDate(invoice.issuedAt)}`
                        : ''}
                    </p>
                    <p className="invoice-item__amount">
                      {invoice.amountCents !== undefined
                        ? formatCents(invoice.amountCents)
                        : '金额未填写'}
                    </p>
                    <p className="page__meta">
                      {countsTowardMealUsage(invoice, tripId)
                        ? '计入餐补已使用金额'
                        : '不计入餐补'}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="form__actions">
              <a className="btn" href="#/invoices">
                前往发票管理
              </a>
            </div>
          </div>

          <div className="trip-item__actions">
            <button
              type="button"
              className="btn"
              onClick={() => setEditing(true)}
            >
              编辑
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setConfirmingDelete(true)}
            >
              删除
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        danger
        title="删除出差记录"
        description={`确认删除「${trip.name}」？此操作不可撤销。`}
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmingDelete(false)}
      />
    </section>
  );
}
