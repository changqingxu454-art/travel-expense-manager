import { useState, type FormEvent, type ReactNode } from 'react';
import type { InvoiceFieldName, Trip } from '../../types';
import { INVOICE_CATEGORIES, INVOICE_STATUSES } from '../../types';
import { formatDisplayDate } from '../../utils/date';
import {
  parseInvoiceFormValues,
  type InvoiceFormFields,
  type InvoiceFormErrors,
  type InvoiceFormValues,
} from './invoiceFormValidation';
import { CATEGORY_LABELS, STATUS_LABELS } from './invoiceLabels';

interface InvoiceFormProps {
  title: string;
  initialValues: InvoiceFormValues;
  trips: Trip[];
  submitLabel: string;
  /** 需要人工核对的字段，用于在字段旁显示标记。 */
  reviewFields: readonly InvoiceFieldName[];
  /** 识别状态说明等提示信息。 */
  notice?: ReactNode;
  /** 已提取的原始文本，折叠展示便于核对。 */
  rawText?: string;
  /** 页级提交错误（保存失败等）。 */
  submitError?: string | null;
  submitting?: boolean;
  onSubmit: (fields: InvoiceFormFields) => void;
  onCancel: () => void;
  /** 额外操作（如标记为识别失败）。 */
  extraActions?: ReactNode;
}

/**
 * 发票核对/编辑表单：识别结果必须经用户确认后才会上报给页面保存。
 * 手机优先，字段校验与提交状态均由组件内部处理。
 */
export default function InvoiceForm({
  title,
  initialValues,
  trips,
  submitLabel,
  reviewFields,
  notice,
  rawText,
  submitError,
  submitting = false,
  onSubmit,
  onCancel,
  extraActions,
}: InvoiceFormProps) {
  const [values, setValues] = useState<InvoiceFormValues>(initialValues);
  const [errors, setErrors] = useState<InvoiceFormErrors>({});

  const setField = <K extends keyof InvoiceFormValues>(
    field: K,
    value: InvoiceFormValues[K],
  ) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      if (!(field in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const needsReview = (field: InvoiceFieldName): boolean =>
    reviewFields.includes(field);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const outcome = parseInvoiceFormValues(values);
    if (!outcome.ok) {
      setErrors(outcome.errors);
      return;
    }
    setErrors({});
    onSubmit(outcome.fields);
  };

  return (
    <form className="card form" onSubmit={handleSubmit} noValidate>
      <h2 className="card__title">{title}</h2>

      {notice ? <div className="alert alert--info">{notice}</div> : null}

      <div className="form__field">
        <div className="form__label-row">
          <label className="form__label" htmlFor="invoice-number">
            发票号码
          </label>
          {needsReview('invoiceNumber') ? <ReviewBadge /> : null}
        </div>
        <input
          id="invoice-number"
          className="form__input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={values.invoiceNumber}
          onChange={(event) => setField('invoiceNumber', event.target.value)}
          aria-invalid={Boolean(errors.invoiceNumber)}
        />
        {errors.invoiceNumber ? (
          <p className="form__error" role="alert">
            {errors.invoiceNumber}
          </p>
        ) : null}
      </div>

      <div className="form__row">
        <div className="form__field">
          <div className="form__label-row">
            <label className="form__label" htmlFor="invoice-date">
              开票日期
            </label>
            {needsReview('issuedAt') ? <ReviewBadge /> : null}
          </div>
          <input
            id="invoice-date"
            className="form__input"
            type="date"
            value={values.issuedAt}
            onChange={(event) => setField('issuedAt', event.target.value)}
            aria-invalid={Boolean(errors.issuedAt)}
          />
          {errors.issuedAt ? (
            <p className="form__error" role="alert">
              {errors.issuedAt}
            </p>
          ) : null}
        </div>

        <div className="form__field">
          <div className="form__label-row">
            <label className="form__label" htmlFor="invoice-amount">
              价税合计（元）
            </label>
            {needsReview('totalCents') ? <ReviewBadge /> : null}
          </div>
          <input
            id="invoice-amount"
            className="form__input"
            type="text"
            inputMode="decimal"
            placeholder="留空表示未识别到金额"
            value={values.amountYuan}
            onChange={(event) => setField('amountYuan', event.target.value)}
            aria-invalid={Boolean(errors.amountYuan)}
          />
          {errors.amountYuan ? (
            <p className="form__error" role="alert">
              {errors.amountYuan}
            </p>
          ) : null}
        </div>
      </div>

      <div className="form__field">
        <div className="form__label-row">
          <label className="form__label" htmlFor="invoice-seller">
            销售方名称
          </label>
          {needsReview('sellerName') ? <ReviewBadge /> : null}
        </div>
        <input
          id="invoice-seller"
          className="form__input"
          type="text"
          autoComplete="off"
          value={values.sellerName}
          onChange={(event) => setField('sellerName', event.target.value)}
          aria-invalid={Boolean(errors.sellerName)}
        />
        {errors.sellerName ? (
          <p className="form__error" role="alert">
            {errors.sellerName}
          </p>
        ) : null}
      </div>

      <div className="form__row">
        <div className="form__field">
          <label className="form__label" htmlFor="invoice-category">
            发票类别
          </label>
          <select
            id="invoice-category"
            className="form__input"
            value={values.category}
            onChange={(event) =>
              setField(
                'category',
                event.target.value as InvoiceFormValues['category'],
              )
            }
          >
            {INVOICE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </div>

        <div className="form__field">
          <label className="form__label" htmlFor="invoice-status">
            识别状态
          </label>
          <select
            id="invoice-status"
            className="form__input"
            value={values.status}
            onChange={(event) =>
              setField('status', event.target.value as InvoiceFormValues['status'])
            }
          >
            {INVOICE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form__field">
        <label className="form__label" htmlFor="invoice-trip">
          关联出差
        </label>
        <select
          id="invoice-trip"
          className="form__input"
          value={values.tripId}
          onChange={(event) => setField('tripId', event.target.value)}
        >
          <option value="">不关联</option>
          {trips.map((trip) => (
            <option key={trip.id} value={trip.id}>
              {trip.name}（{formatDisplayDate(trip.startDate)}）
            </option>
          ))}
        </select>
        {trips.length === 0 ? (
          <p className="page__meta">暂无出差记录，可先保存发票稍后再关联。</p>
        ) : null}
      </div>

      {rawText ? (
        <details className="raw-text">
          <summary>查看提取到的原始文本（用于核对）</summary>
          <pre className="raw-text__body">{rawText}</pre>
        </details>
      ) : null}

      {submitError ? (
        <p className="form__error form__error--block" role="alert">
          {submitError}
        </p>
      ) : null}

      <div className="form__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
          取消
        </button>
        {extraActions}
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? '保存中…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function ReviewBadge() {
  return <span className="badge badge--warn">待核对</span>;
}
