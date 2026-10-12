/**
 * 全局类型定义。
 *
 * 约定：
 * - 所有金额均以「分」为单位的整数保存（人民币），避免浮点误差。
 * - 日期以 ISO 8601 字符串（YYYY-MM-DD）保存以便 IndexedDB 索引与排序。
 * - 本文件只放类型与常量，不放业务计算逻辑。
 */

/** 金额：以分为单位的整数。 */
export type Cents = number;

/** 出差状态。 */
export type TripStatus = 'planned' | 'ongoing' | 'completed' | 'cancelled';

/** 创建/更新出差记录时由表单与业务层传递的输入。 */
export interface TripInput {
  /** 出差名称。 */
  name: string;
  /** 开始日期 YYYY-MM-DD。 */
  startDate: string;
  /** 结束日期 YYYY-MM-DD。 */
  endDate: string;
  /** 每日餐数（不小于 0 的整数）。 */
  mealsPerDay: number;
  /** 每餐标准（分）。 */
  mealStandardCents: Cents;
  /** 目的地，可选。 */
  destination?: string;
  /** 出差事由，可选。 */
  purpose?: string;
  /** 备注，可选。 */
  note?: string;
}

/** 一次出差记录。 */
export interface Trip extends TripInput {
  id: string;
  status: TripStatus;
  createdAt: string;
  updatedAt: string;
}

/** 餐标计算入参；餐数与每餐标准可省略，使用默认值。 */
export interface MealBudgetInput {
  startDate: string;
  endDate: string;
  /** 每日餐数，默认 2。 */
  mealsPerDay?: number;
  /** 每餐标准（分），默认 2500（25 元）。 */
  mealStandardCents?: Cents;
}

/** 餐标计算结果（纯计算，不含实际发生额）。 */
export interface MealBudget {
  /** 出差天数（首尾均包含）。 */
  days: number;
  mealsPerDay: number;
  mealStandardCents: Cents;
  /** 餐补总额度（分）。 */
  totalCents: Cents;
}

/**
 * 单次出差的餐补使用统计（预算 + 已使用 + 结果），全部以整数分为单位。
 *
 * 统计口径见 `services/budgetService`：已使用金额只包含
 * 「状态为已确认 + 类别为餐饮 + 已关联到本次出差」的发票。
 */
export interface MealUsageSummary {
  /** 餐补预算（分）。 */
  budgetCents: Cents;
  /** 餐补已使用金额（分）。 */
  usedCents: Cents;
  /** 剩余餐补（分），允许为负数。 */
  remainingCents: Cents;
  /** 是否超出预算。 */
  isOverBudget: boolean;
  /** 超额金额（分）；未超额时为 0。 */
  overBudgetCents: Cents;
  /** 已使用比例，0–100 的整数，仅用于展示；预算为 0 时为 0。 */
  usagePercent: number;
}

/** 出差中的单日餐标明细。 */
export interface TripMealDay {
  /** 日期 YYYY-MM-DD。 */
  date: string;
  /** 当日餐标额度（分）。 */
  allowanceCents: Cents;
  /** 当日实际餐费（分）。 */
  actualCents: Cents;
}

/** 发票来源类型。 */
export type InvoiceSource = 'pdf' | 'image' | 'manual';

/** 发票类别。 */
export type InvoiceCategory = 'meal' | 'accommodation' | 'transport' | 'other';

/** 发票识别/核对状态。 */
export type InvoiceStatus = 'pending' | 'confirmed' | 'failed';

/** 可选择或需要核对的发票字段名。 */
export type InvoiceFieldName =
  | 'invoiceNumber'
  | 'issuedAt'
  | 'sellerName'
  | 'totalCents';

export const INVOICE_CATEGORIES: readonly InvoiceCategory[] = [
  'meal',
  'accommodation',
  'transport',
  'other',
];

export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'pending',
  'confirmed',
  'failed',
];

/** 创建/更新发票时由表单与业务层传递的输入。 */
export interface InvoiceInput {
  /** 发票号码；识别失败时可为空。 */
  invoiceNumber?: string;
  /** 开票日期 YYYY-MM-DD；识别失败时可为空。 */
  issuedAt?: string;
  /** 销售方名称；识别失败时可为空。 */
  sellerName?: string;
  /** 价税合计（分）。缺失时保持 undefined，绝不伪造为 0。 */
  amountCents?: Cents;
  category: InvoiceCategory;
  status: InvoiceStatus;
  /** 关联的出差记录 id；未关联时为空。 */
  tripId?: string;
  /** 原始文件名。手工录入时可为空串。 */
  fileName: string;
  mimeType: string;
  size: number;
  source: InvoiceSource;
  /** 从 PDF 提取的原始文本，便于回溯核对。 */
  rawText?: string;
}

/** 一张发票。 */
export interface Invoice extends InvoiceInput {
  id: string;
  /**
   * 关联的 PDF 文件 id（对应 invoiceFiles 仓库）。
   *
   * 由 invoiceService 统一生成与维护，不接受外部传入，避免出现指向不存在文件的
   * 悬空引用。手工录入且无文件的发票为空。
   */
  fileId?: string;
  createdAt: string;
  updatedAt: string;
}

/** IndexedDB 中已存储的发票文件二进制内容。 */
export interface InvoiceFile {
  /** 文件 id，被 {@link Invoice.fileId} 引用；与发票 id 分离以便多记录共享同一文件。 */
  id: string;
  /** 原始文件字节。 */
  blob: Blob;
  mimeType: string;
  fileName: string;
  /** 文件字节数，便于校验。 */
  size: number;
  createdAt: string;
}

/** 发票文本解析状态。 */
export type InvoiceParseStatus = 'parsed' | 'partial' | 'unrecognized';

/** 从文本中解析出的发票字段。缺失字段保持 undefined。 */
export interface ParsedInvoiceFields {
  invoiceNumber?: string;
  issuedAt?: string;
  sellerName?: string;
  /** 价税合计（分）。 */
  totalCents?: Cents;
  /** 不含税金额（分）。 */
  amountWithoutTaxCents?: Cents;
  /** 税额（分）。 */
  taxCents?: Cents;
}

/** 发票文本解析结果（纯函数输出，不含任何副作用）。 */
export interface InvoiceParseResult {
  status: InvoiceParseStatus;
  fields: ParsedInvoiceFields;
  /** 已识别且无歧义的字段。 */
  recognized: InvoiceFieldName[];
  /** 缺失或存在歧义、需要人工核对的字段。 */
  needsReview: InvoiceFieldName[];
  /** 面向用户的状态说明。 */
  message: string;
}

/** PDF 文本提取结果。 */
export interface PdfExtractResult {
  /** 所有页面按顺序拼接的文本。 */
  text: string;
  /** 每页单独文本，便于按页核对。 */
  pages: string[];
  pageCount: number;
  /** 是否存在可提取的文本；扫描版 PDF 为 false。 */
  hasText: boolean;
}

/** 计算或解析失败时的结果包装，避免用异常表达可预期的业务分支。 */
export type Result<T, E = AppErrorInfo> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** 统一的错误信息结构。 */
export interface AppErrorInfo {
  code: string;
  message: string;
}
