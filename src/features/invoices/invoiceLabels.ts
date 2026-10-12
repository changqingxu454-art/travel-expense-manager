import type {
  InvoiceCategory,
  InvoiceFieldName,
  InvoiceStatus,
} from '../../types';

export const CATEGORY_LABELS: Record<InvoiceCategory, string> = {
  meal: '餐饮',
  accommodation: '住宿',
  transport: '交通',
  other: '其他',
};

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  pending: '待核对',
  confirmed: '已确认',
  failed: '识别失败',
};

export const FIELD_LABELS: Record<InvoiceFieldName, string> = {
  invoiceNumber: '发票号码',
  issuedAt: '开票日期',
  sellerName: '销售方名称',
  totalCents: '价税合计',
};
