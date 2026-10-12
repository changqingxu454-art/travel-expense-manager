import EmptyState from '../components/EmptyState';
import { useFinanceOverview } from '../features/budget/useFinanceOverview';
import { useMealUsageList } from '../features/budget/useMealUsageList';
import TripBudgetSummary from '../features/trips/TripBudgetSummary';
import { useTrips } from '../features/trips/useTrips';
import { formatCents } from '../utils/budget';
import { formatDisplayDate } from '../utils/date';

/** 首页概览：财务总览卡片 + 最近的出差记录与创建入口。 */
export default function Dashboard() {
  const { trips, loading, error } = useTrips();
  // 与列表页共用同一批量统计，保证首页与详情页口径一致且不产生 N+1 查询。
  const { usageByTrip, error: usageError } = useMealUsageList(trips);
  // 财务总览：复用服务层统计，不在这里重新实现筛选规则。
  const { overview, loading: overviewLoading, error: overviewError } =
    useFinanceOverview();
  const recent = trips.slice(0, 3);

  const mealRemainingOver = overview !== null && overview.mealRemainingCents < 0;

  return (
    <section className="page">
      <div className="overview-grid">
        <div className="stat-card">
          <p className="stat-card__label">出差记录</p>
          <p className="stat-card__value">
            {overviewLoading && overview === null ? '…' : overview?.tripCount ?? '--'}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-card__label">餐补预算总额</p>
          <p className="stat-card__value">
            {overviewLoading && overview === null
              ? '…'
              : overview !== null
                ? formatCents(overview.budgetTotalCents)
                : '--'}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-card__label">餐补已使用</p>
          <p className="stat-card__value">
            {overviewLoading && overview === null
              ? '…'
              : overview !== null
                ? formatCents(overview.mealUsedTotalCents)
                : '--'}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-card__label">餐补剩余额度</p>
          <p
            className={
              mealRemainingOver
                ? 'stat-card__value stat-card__value--over'
                : 'stat-card__value'
            }
          >
            {overviewLoading && overview === null
              ? '…'
              : overview !== null
                ? formatCents(overview.mealRemainingCents)
                : '--'}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-card__label">已确认发票合计</p>
          <p className="stat-card__value">
            {overviewLoading && overview === null
              ? '…'
              : overview !== null
                ? formatCents(overview.confirmedInvoiceTotalCents)
                : '--'}
          </p>
        </div>
        <div className="stat-card">
          <p className="stat-card__label">待核对发票</p>
          <p className="stat-card__value">
            {overviewLoading && overview === null
              ? '…'
              : overview?.pendingInvoiceCount ?? '--'}
          </p>
        </div>
      </div>

      <p className="page__meta">
        餐补统计仅含「已确认 + 餐饮类别 + 已关联出差」的发票；已确认发票合计含全部类别，与餐补口径相互独立。
      </p>

      {loading ? <p className="page__meta">正在读取本地数据…</p> : null}

      {!loading && error ? (
        <p className="form__error form__error--block" role="alert">
          读取出差记录失败：{error}
        </p>
      ) : null}

      {!loading && !error && usageError ? (
        <p className="form__error form__error--block" role="alert">
          读取餐补使用情况失败：{usageError}
        </p>
      ) : null}

      {!loading && !error && overviewError ? (
        <p className="form__error form__error--block" role="alert">
          读取财务总览失败：{overviewError}
        </p>
      ) : null}

      <div className="page__toolbar">
        <h2 className="section-title">最近的出差</h2>
        <a className="btn btn--primary" href="#/trips">
          创建出差
        </a>
      </div>

      {!loading && !error && trips.length === 0 ? (
        <EmptyState
          title="还没有出差记录"
          description="创建第一条出差记录后，这里会显示最近的行程与餐补额度。"
        />
      ) : null}

      {!loading && !error && recent.length > 0 ? (
        <ul className="trip-list">
          {recent.map((trip) => (
            <li key={trip.id} className="card">
              <a
                className="trip-item__name"
                href={`#/trips/${encodeURIComponent(trip.id)}`}
              >
                {trip.name}
              </a>
              <p className="page__meta">
                {formatDisplayDate(trip.startDate)} – {formatDisplayDate(trip.endDate)}
              </p>
              {/* 每次出差的餐补统计各自独立，不会把不同出差的数据混在一起。 */}
              <TripBudgetSummary
                trip={trip}
                usedCents={usageByTrip.get(trip.id)?.usedCents}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
