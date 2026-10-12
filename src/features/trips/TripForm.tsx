import { useState, type FormEvent } from 'react';
import type { Result, Trip, TripInput } from '../../types';
import { toErrorInfo } from '../../utils/errors';
import { formatCents } from '../../utils/budget';
import {
  calculateTripBudget,
  createDefaultTripFormValues,
  parseTripFormValues,
  toTripFormValues,
  type TripFormValues,
} from './tripValidation';

interface TripFormProps {
  /** 传入已有记录则为编辑模式，否则为新建模式。 */
  trip?: Trip;
  onSubmit: (input: TripInput) => Promise<void>;
  onCancel: () => void;
}

const FIELD_LABELS: Record<keyof TripFormValues, string> = {
  name: '出差名称',
  startDate: '开始日期',
  endDate: '结束日期',
  mealsPerDay: '每日餐数',
  mealStandardYuan: '每餐标准（元）',
};

/** 出差新建/编辑表单；手机优先，含实时校验与防重复提交。 */
export default function TripForm({ trip, onSubmit, onCancel }: TripFormProps) {
  const [values, setValues] = useState<TripFormValues>(() =>
    trip ? toTripFormValues(trip) : createDefaultTripFormValues(),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof TripFormValues, string>>
  >({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isEditing = Boolean(trip);

  const setField = (field: keyof TripFormValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!(field in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  // 实时预览：仅当输入能解析出合法餐标时展示，否则不显示，绝不编造数字。
  const preview = calculatePreview(values);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitError(null);

    const parsed = parseTripFormValues(values);
    if (!parsed.ok) {
      setFieldErrors(mapErrorToField(parsed));
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    try {
      await onSubmit(parsed.value);
    } catch (error) {
      setSubmitError(toErrorInfo(error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card form" onSubmit={handleSubmit} noValidate>
      <h2 className="card__title">{isEditing ? '编辑出差' : '新建出差'}</h2>

      <div className="form__field">
        <label className="form__label" htmlFor="trip-name">
          {FIELD_LABELS.name}
        </label>
        <input
          id="trip-name"
          className="form__input"
          type="text"
          value={values.name}
          placeholder="例如：北京出差"
          autoComplete="off"
          onChange={(event) => setField('name', event.target.value)}
          aria-invalid={Boolean(fieldErrors.name)}
        />
        {fieldErrors.name ? (
          <p className="form__error" role="alert">
            {fieldErrors.name}
          </p>
        ) : null}
      </div>

      <div className="form__row">
        <div className="form__field">
          <label className="form__label" htmlFor="trip-start">
            {FIELD_LABELS.startDate}
          </label>
          <input
            id="trip-start"
            className="form__input"
            type="date"
            value={values.startDate}
            onChange={(event) => setField('startDate', event.target.value)}
            aria-invalid={Boolean(fieldErrors.startDate)}
          />
          {fieldErrors.startDate ? (
            <p className="form__error" role="alert">
              {fieldErrors.startDate}
            </p>
          ) : null}
        </div>

        <div className="form__field">
          <label className="form__label" htmlFor="trip-end">
            {FIELD_LABELS.endDate}
          </label>
          <input
            id="trip-end"
            className="form__input"
            type="date"
            value={values.endDate}
            onChange={(event) => setField('endDate', event.target.value)}
            aria-invalid={Boolean(fieldErrors.endDate)}
          />
          {fieldErrors.endDate ? (
            <p className="form__error" role="alert">
              {fieldErrors.endDate}
            </p>
          ) : null}
        </div>
      </div>

      <div className="form__row">
        <div className="form__field">
          <label className="form__label" htmlFor="trip-meals">
            {FIELD_LABELS.mealsPerDay}
          </label>
          <input
            id="trip-meals"
            className="form__input"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={values.mealsPerDay}
            onChange={(event) => setField('mealsPerDay', event.target.value)}
            aria-invalid={Boolean(fieldErrors.mealsPerDay)}
          />
          {fieldErrors.mealsPerDay ? (
            <p className="form__error" role="alert">
              {fieldErrors.mealsPerDay}
            </p>
          ) : null}
        </div>

        <div className="form__field">
          <label className="form__label" htmlFor="trip-standard">
            {FIELD_LABELS.mealStandardYuan}
          </label>
          <input
            id="trip-standard"
            className="form__input"
            type="text"
            inputMode="decimal"
            value={values.mealStandardYuan}
            placeholder="25"
            onChange={(event) => setField('mealStandardYuan', event.target.value)}
            aria-invalid={Boolean(fieldErrors.mealStandardYuan)}
          />
          {fieldErrors.mealStandardYuan ? (
            <p className="form__error" role="alert">
              {fieldErrors.mealStandardYuan}
            </p>
          ) : null}
        </div>
      </div>

      {preview ? (
        <p className="form__preview" data-testid="trip-budget-preview">
          预计出差 {preview.days} 天，餐补额度 {formatCents(preview.totalCents)}
        </p>
      ) : null}

      {submitError ? (
        <p className="form__error form__error--block" role="alert">
          {submitError}
        </p>
      ) : null}

      <div className="form__actions">
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={submitting}
        >
          取消
        </button>
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

/** 尝试预览额度；输入不合法时返回 null（不展示任何数字）。 */
function calculatePreview(values: TripFormValues) {
  const parsed = parseTripFormValues(values);
  if (!parsed.ok) {
    return null;
  }
  const budget = calculateTripBudget({
    ...parsed.value,
    id: 'preview',
    status: 'planned',
    createdAt: '',
    updatedAt: '',
  });
  return budget.ok ? budget.value : null;
}

function mapErrorToField(
  error: Result<TripInput>,
): Partial<Record<keyof TripFormValues, string>> {
  if (error.ok) {
    return {};
  }
  const message = error.error.message;
  switch (error.error.code) {
    case 'INVALID_NAME':
      return { name: message };
    case 'INVALID_DATE_RANGE':
      // 区间错误由结束日期引起，仅在结束日期处提示，避免同一条信息重复两遍。
      return { endDate: message };
    case 'INVALID_DATE':
      return { startDate: message, endDate: message };
    case 'INVALID_MEALS':
      return { mealsPerDay: message };
    case 'INVALID_MEAL_STANDARD':
    case 'INVALID_AMOUNT':
      return { mealStandardYuan: message };
    default:
      return { name: message };
  }
}
