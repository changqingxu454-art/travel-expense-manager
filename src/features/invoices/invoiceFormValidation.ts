import type { Cents, InvoiceCategory, InvoiceStatus } from '../../types';
import { parseYuanToCents } from '../../utils/budget';
import { isDateString } from '../../utils/date';

/** 发票表单中由用户直接编辑的字段（全部为字符串）。 */
export interface InvoiceFormValues {
  invoiceNumber: string;
  issuedAt: string;
  sellerName: string;
  amountYuan: string;
  category: InvoiceCategory;
  status: InvoiceStatus;
  /** 关联的出差 id；空串表示不关联。 */
  tripId: string;
}

/** 校验通过后的可编辑字段。 */
export interface InvoiceFormFields {
  invoiceNumber?: string;
  issuedAt?: string;
  sellerName?: string;
  amountCents?: Cents;
  category: InvoiceCategory;
  status: InvoiceStatus;
  tripId?: string;
}

export type InvoiceFormErrors = Partial<Record<keyof InvoiceFormValues, string>>;

export type InvoiceFormOutcome =
  | { ok: true; fields: InvoiceFormFields }
  | { ok: false; errors: InvoiceFormErrors };

export function createEmptyInvoiceFormValues(): InvoiceFormValues {
  return {
    invoiceNumber: '',
    issuedAt: '',
    sellerName: '',
    amountYuan: '',
    category: 'other',
    status: 'pending',
    tripId: '',
  };
}

/**
 * 校验发票表单。
 *
 * 关键约束：金额留空时结果为 `undefined`（绝不默认 0）；状态为「已确认」时必须填写金额。
 */
export function parseInvoiceFormValues(
  values: InvoiceFormValues,
): InvoiceFormOutcome {
  const errors: InvoiceFormErrors = {};
  const invoiceNumber = values.invoiceNumber.trim();
  const sellerName = values.sellerName.trim();
  const issuedAt = values.issuedAt.trim();
  const amountRaw = values.amountYuan.trim();
  const tripId = values.tripId.trim();

  let amountCents: Cents | undefined;
  if (amountRaw !== '') {
    const parsed = parseYuanToCents(amountRaw);
    if (!parsed.ok) {
      errors.amountYuan = parsed.error.message;
    } else {
      amountCents = parsed.value;
    }
  }

  if (values.status === 'confirmed' && amountCents === undefined) {
    errors.amountYuan =
      errors.amountYuan ?? '标记为「已确认」前必须填写金额（缺失金额不会按 0 元处理）。';
  }

  if (issuedAt !== '' && !isDateString(issuedAt)) {
    errors.issuedAt = '开票日期需为合法日期（YYYY-MM-DD）。';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    fields: {
      category: values.category,
      status: values.status,
      ...(invoiceNumber !== '' ? { invoiceNumber } : {}),
      ...(issuedAt !== '' ? { issuedAt } : {}),
      ...(sellerName !== '' ? { sellerName } : {}),
      ...(amountCents !== undefined ? { amountCents } : {}),
      ...(tripId !== '' ? { tripId } : {}),
    },
  };
}
