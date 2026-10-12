import { useCallback, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import { useMealUsageList } from '../features/budget/useMealUsageList';
import TripForm from '../features/trips/TripForm';
import { useTrips } from '../features/trips/useTrips';
import type { MealUsageSummary, Trip, TripInput } from '../types';
import { formatCents } from '../utils/budget';
import { formatDisplayDate } from '../utils/date';
import { toErrorInfo } from '../utils/errors';
import { createTrip, removeTrip, updateTrip } from '../services/tripService';
import { calculateTripBudget } from '../features/trips/tripValidation';

type FormMode = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; trip: Trip };

/** 出差记录列表页：支持创建、编辑、删除与查看详情。 */
export default function Trips() {
  const { trips, loading, error, reload } = useTrips();
  // 一次查询批量取得所有出差的餐补使用情况，避免逐条查询造成 N+1。
  const {
    usageByTrip,
    error: usageError,
    reload: reloadUsage,
  } = useMealUsageList(trips);
  const [formMode, setFormMode] = useState<FormMode>({ kind: 'closed' });
  const [pendingDelete, setPendingDelete] = useState<Trip | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (input: TripInput) => {
      if (formMode.kind === 'edit') {
        await updateTrip(formMode.trip.id, input);
      } else {
        await createTrip(input);
      }
      // 保存成功后重新读取数据库，确保页面展示的是持久化后的真实数据。
      await reload();
      setFormMode({ kind: 'closed' });
    },
    [formMode, reload],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return;
    }
    setActionError(null);
    try {
      await removeTrip(pendingDelete.id);
      await reload();
      setPendingDelete(null);
    } catch (err) {
      setActionError(toErrorInfo(err).message);
      setPendingDelete(null);
    }
  }, [pendingDelete, reload]);

  /** 重新读取列表与餐补统计（统计失败时的重试入口）。 */
  const reloadAll = useCallback(async () => {
    await Promise.all([reload(), reloadUsage()]);
  }, [reload, reloadUsage]);

  return (
    <section className="page">
      <div className="page__toolbar">
        <p className="page__meta">共 {trips.length} 条记录</p>
        {formMode.kind === 'closed' ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setFormMode({ kind: 'create' })}
          >
            新建出差
          </button>
        ) : null}
      </div>

      {actionError ? (
        <p className="form__error form__error--block" role="alert">
          {actionError}
        </p>
      ) : null}

      {formMode.kind !== 'closed' ? (
        <TripForm
          {...(formMode.kind === 'edit' ? { trip: formMode.trip } : {})}
          onSubmit={handleSubmit}
          onCancel={() => setFormMode({ kind: 'closed' })}
        />
      ) : null}

      {loading ? <p className="page__meta">正在读取本地数据…</p> : null}

      {!loading && error ? (
        <div className="card">
          <p className="form__error" role="alert">
            读取出差记录失败：{error}
          </p>
          <button type="button" className="btn" onClick={() => void reloadAll()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !error && usageError ? (
        <div className="card">
          <p className="form__error" role="alert">
            读取餐补使用情况失败：{usageError}
          </p>
          <p className="page__meta">
            为避免误读，下方列表暂不展示「已用餐补」，出差记录本身不受影响。
          </p>
          <button type="button" className="btn" onClick={() => void reloadUsage()}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && !error && trips.length === 0 ? (
        <EmptyState
          title="还没有出差记录"
          description="点击「新建出差」添加第一条记录，数据只保存在本机浏览器。"
        />
      ) : null}

      {!loading && !error && trips.length > 0 ? (
        <ul className="trip-list">
          {trips.map((trip) => {
            const usage = usageByTrip.get(trip.id);
            return (
              <TripListItem
                key={trip.id}
                trip={trip}
                {...(usage !== undefined ? { usage } : {})}
                onEdit={() => setFormMode({ kind: 'edit', trip })}
                onDelete={() => setPendingDelete(trip)}
              />
            );
          })}
        </ul>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="删除出差记录"
        description={
          pendingDelete
            ? `确认删除「${pendingDelete.name}」？此操作不可撤销。`
            : ''
        }
        confirmText="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

interface TripListItemProps {
  trip: Trip;
  /** 该出差的餐补使用统计；统计未取得时不展示，避免显示成 0 元。 */
  usage?: MealUsageSummary | undefined;
  onEdit: () => void;
  onDelete: () => void;
}

function TripListItem({ trip, usage, onEdit, onDelete }: TripListItemProps) {
  const budget = calculateTripBudget(trip);
  return (
    <li className="card trip-item">
      <div className="trip-item__head">
        <a className="trip-item__name" href={`#/trips/${encodeURIComponent(trip.id)}`}>
          {trip.name}
        </a>
      </div>
      <p className="page__meta">
        {formatDisplayDate(trip.startDate)} – {formatDisplayDate(trip.endDate)}
      </p>
      <p className="page__meta">
        {budget.ok
          ? `${budget.value.days} 天 · 每日 ${budget.value.mealsPerDay} 餐 · 餐补 ${formatCents(
              budget.value.totalCents,
            )}`
          : `无法计算餐补：${budget.error.message}`}
      </p>
      {usage !== undefined ? (
        <p className={usage.isOverBudget ? 'page__meta summary__warning' : 'page__meta'}>
          {usage.isOverBudget
            ? `已用 ${formatCents(usage.usedCents)} · 超出餐补 ${formatCents(
                usage.overBudgetCents,
              )}`
            : `已用 ${formatCents(usage.usedCents)} · 剩余 ${formatCents(
                usage.remainingCents,
              )}`}
        </p>
      ) : null}
      <div className="trip-item__actions">
        <a className="btn" href={`#/trips/${encodeURIComponent(trip.id)}`}>
          详情
        </a>
        <button type="button" className="btn" onClick={onEdit}>
          编辑
        </button>
        <button type="button" className="btn btn--danger" onClick={onDelete}>
          删除
        </button>
      </div>
    </li>
  );
}
