import type { Trip } from '../../types';
import { formatCents, summarizeMealUsage } from '../../utils/budget';
import { calculateTripBudget } from './tripValidation';

interface TripBudgetSummaryProps {
  trip: Trip;
  /**
   * 餐补已使用金额（分）。
   *
   * 为 `undefined` 表示统计数据尚未取得（读取中或失败），此时展示占位符，
   * 而不是把「未知」显示成 0 元。
   */
  usedCents?: number | undefined;
  /** 统计数据读取失败的原因；存在时明确提示，绝不静默按 0 元展示。 */
  error?: string | null;
}

/**
 * 展示单条出差记录的餐补预算、已使用金额、剩余/超额与已使用比例。
 *
 * 统计口径由 `services/budgetService` 统一提供（已确认 + 餐饮类别 + 已关联本次出差），
 * 本组件只负责展示，不重复实现筛选或求和规则。
 *
 * 当餐补无法计算（数据异常）时，明确显示失败原因，绝不展示编造的数字。
 */
export default function TripBudgetSummary({
  trip,
  usedCents,
  error = null,
}: TripBudgetSummaryProps) {
  const budget = calculateTripBudget(trip);

  if (!budget.ok) {
    return (
      <p className="form__error" role="alert">
        无法计算餐补：{budget.error.message}
      </p>
    );
  }

  const { days, totalCents } = budget.value;

  if (error !== null) {
    // 读取失败：只展示确定的预算部分，并明确报错，不展示「已使用 0 元」这类误导信息。
    return (
      <div>
        <dl className="summary">
          <div className="summary__item">
            <dt className="summary__label">出差天数</dt>
            <dd className="summary__value">{days} 天</dd>
          </div>
          <div className="summary__item">
            <dt className="summary__label">餐补总额度</dt>
            <dd className="summary__value">{formatCents(totalCents)}</dd>
          </div>
        </dl>
        <p className="form__error" role="alert">
          读取餐补使用情况失败：{error}
        </p>
      </div>
    );
  }

  const known = usedCents !== undefined;
  const usage = summarizeMealUsage(totalCents, usedCents ?? 0);
  const over = known && usage.isOverBudget;

  return (
    <div>
      <dl className="summary">
        <div className="summary__item">
          <dt className="summary__label">出差天数</dt>
          <dd className="summary__value">{days} 天</dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">餐补总额度</dt>
          <dd className="summary__value">{formatCents(totalCents)}</dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">已使用金额</dt>
          <dd className="summary__value">
            {known ? formatCents(usage.usedCents) : '…'}
          </dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">{over ? '超出额度' : '剩余额度'}</dt>
          <dd
            className={
              over ? 'summary__value summary__value--over' : 'summary__value'
            }
          >
            {known
              ? formatCents(over ? usage.overBudgetCents : usage.remainingCents)
              : '…'}
          </dd>
        </div>
        <div className="summary__item">
          <dt className="summary__label">已使用比例</dt>
          <dd className="summary__value">
            {known ? `${usage.usagePercent}%` : '…'}
          </dd>
        </div>
      </dl>

      {known ? (
        <div
          className="progress"
          role="progressbar"
          aria-label="餐补已使用比例"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usage.usagePercent}
        >
          {/* 比例已截断到 100%，超额金额在下方单独显示，避免进度条撑破布局。 */}
          <div
            className={over ? 'progress__bar progress__bar--over' : 'progress__bar'}
            style={{ width: `${usage.usagePercent}%` }}
          />
        </div>
      ) : null}

      {over ? (
        <p className="summary__warning" role="status">
          已超出餐补额度 {formatCents(usage.overBudgetCents)}，请在确认发票时留意。
        </p>
      ) : null}
    </div>
  );
}
