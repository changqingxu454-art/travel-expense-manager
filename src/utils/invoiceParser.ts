import type {
  Cents,
  InvoiceFieldName,
  InvoiceParseResult,
  InvoiceParseStatus,
  ParsedInvoiceFields,
} from '../types';
import { parseYuanToCents } from './budget';
import { isDateString } from './date';

/**
 * 发票文本解析（纯函数：不访问数据库、文件系统或网络）。
 *
 * 设计原则：
 * - 优先匹配明确标注的字段（如「价税合计」），绝不直接取文本里的第一个金额。
 * - 金额、税额、不含税金额与价税合计分别提取，互不代替。
 * - 缺失或存在歧义的字段不写入猜测值，而是列入 `needsReview` 交由用户核对。
 * - 缺失金额时 `totalCents` 保持 undefined，绝不自动填成 0 元。
 */

/** 把「1,234.56」「1 234.56」这类文本转换成整数分。 */
function amountToCents(raw: string): Cents | undefined {
  const normalized = raw.replace(/[,\s]/g, '');
  const parsed = parseYuanToCents(normalized);
  return parsed.ok ? parsed.value : undefined;
}

/** 文本中可能出现全角字符，统一半角化以便匹配。 */
function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[：]/g, ':')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[￥]/g, '¥');
}

/** 收集某个正则的全部捕获组结果。 */
function collectMatches(text: string, pattern: RegExp): string[] {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const values: string[] = [];
  let match = global.exec(text);
  while (match !== null) {
    const captured = match[1];
    if (captured !== undefined) {
      values.push(captured);
    }
    match = global.exec(text);
  }
  return values;
}

/**
 * 从多个候选中确定唯一值。
 * - 0 个候选：缺失 → 需要核对
 * - 1 个不同取值：确定
 * - 多个不同取值：歧义 → 需要核对，且不写入任何值
 */
function pickUnique<T>(
  candidates: T[],
): { value?: T; ambiguous: boolean } {
  const unique: T[] = [];
  for (const candidate of candidates) {
    if (!unique.some((item) => item === candidate)) {
      unique.push(candidate);
    }
  }
  if (unique.length === 1) {
    const only = unique[0];
    return only === undefined ? { ambiguous: false } : { value: only, ambiguous: false };
  }
  return { ambiguous: unique.length > 1 };
}

const PATTERNS = {
  // 电子发票号码通常为 8–25 位数字；不匹配「发票代码」以免混淆。
  invoiceNumber: /(?:发票号码|发票号|票据号码)\s*:?\s*([0-9]{6,25})/,
  // 仅匹配明确的开票日期标签，避免误取校验码日期等其它日期。
  issuedAt:
    /(?:开票日期|开具日期|开票时间|填开日期)\s*:?\s*(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/,
  // 销售方名称支持三类写法：
  // 1) 电子发票分块式「销售方信息 … 名称：XX」
  // 2) 明确标签「销售方名称：XX」
  // 3) 简写「销售方：XX」（必须有冒号，避免把「销售方信息」误当名称）
  sellerNameBlock: /销售方信息[\s\S]{0,80}?名称\s*:?\s*([^\n]{1,80})/,
  sellerNameNamed: /(?:销售方名称|销方名称)\s*:?\s*([^\n]{1,80})/,
  sellerNameColon: /(?:销售方|销方)\s*:\s*([^\n]{1,80})/,
  totalWithLowercase:
    /价税合计(?:[^\n]{0,60}?\(小写\))?\s*:?\s*¥?\s*([0-9][0-9,\s]*\.\d{2})/,
  amountWithoutTax: /(?:合计金额|金额合计|不含税金额)\s*:?\s*¥?\s*([0-9][0-9,\s]*\.\d{2})/,
  // 标准增值税发票表体：「合计 ¥不含税 ¥税额」
  amountAndTaxPair:
    /合计\s*¥\s*([0-9][0-9,]*\.\d{2})\s*¥\s*([0-9][0-9,]*\.\d{2})/,
  tax: /(?:税额合计|合计税额|税额)\s*:?\s*¥?\s*([0-9][0-9,\s]*\.\d{2})/,
} as const;

/** 销售方名称中不应包含的后续标签，用于截断尾部。 */
const SELLER_STOP_LABELS = [
  '纳税人识别号',
  '统一社会信用代码',
  '税号',
  '地址',
  '电话',
  '开户行',
  '账号',
  '购买方',
  '销售方地址',
];

function cleanSellerName(raw: string): string | undefined {
  let name = raw.trim();
  for (const label of SELLER_STOP_LABELS) {
    const index = name.indexOf(label);
    if (index > 0) {
      name = name.slice(0, index).trim();
    }
  }
  // 去掉可能残留的分隔符与空白。
  name = name.replace(/[,:;\s]+$/, '').trim();
  // 过短或明显不是名称时视为未识别，避免写入无意义的片段。
  return name.length >= 2 ? name : undefined;
}

function parseIssuedAt(text: string): { value?: string; ambiguous: boolean } {
  const pattern = new RegExp(
    PATTERNS.issuedAt.source,
    `${PATTERNS.issuedAt.flags}g`,
  );
  const dates: string[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const year = match[1];
    const month = match[2];
    const day = match[3];
    if (year && month && day) {
      const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      // 非法日期（如 2026-13-45）不写入，交由用户核对。
      if (isDateString(candidate)) {
        dates.push(candidate);
      }
    }
    match = pattern.exec(text);
  }
  return pickUnique(dates);
}

function parseInvoiceNumber(text: string): { value?: string; ambiguous: boolean } {
  return pickUnique(collectMatches(text, PATTERNS.invoiceNumber));
}

function parseSellerName(text: string): { value?: string; ambiguous: boolean } {
  const candidates: string[] = [];
  for (const pattern of [
    PATTERNS.sellerNameBlock,
    PATTERNS.sellerNameNamed,
    PATTERNS.sellerNameColon,
  ]) {
    const raw = new RegExp(pattern.source).exec(text)?.[1];
    if (raw) {
      const cleaned = cleanSellerName(raw);
      if (cleaned) {
        candidates.push(cleaned);
      }
    }
  }
  return pickUnique(candidates);
}

function parseAmounts(text: string): {
  totalCents?: Cents;
  totalAmbiguous: boolean;
  withoutTaxCents?: Cents;
  taxCents?: Cents;
} {
  const totals: Cents[] = [];
  for (const raw of collectMatches(text, PATTERNS.totalWithLowercase)) {
    const cents = amountToCents(raw);
    if (cents !== undefined) {
      totals.push(cents);
    }
  }
  const total = pickUnique(totals);

  const withoutTax: Cents[] = [];
  const taxes: Cents[] = [];

  // 表体「合计 ¥不含税 ¥税额」成对出现，优先级高于单值匹配。
  const pair = new RegExp(PATTERNS.amountAndTaxPair.source).exec(text);
  const pairWithoutTax = pair?.[1] ? amountToCents(pair[1]) : undefined;
  const pairTax = pair?.[2] ? amountToCents(pair[2]) : undefined;
  if (pairWithoutTax !== undefined) {
    withoutTax.push(pairWithoutTax);
  }
  if (pairTax !== undefined) {
    taxes.push(pairTax);
  }

  for (const raw of collectMatches(text, PATTERNS.amountWithoutTax)) {
    const cents = amountToCents(raw);
    if (cents !== undefined) {
      withoutTax.push(cents);
    }
  }
  for (const raw of collectMatches(text, PATTERNS.tax)) {
    const cents = amountToCents(raw);
    if (cents !== undefined) {
      taxes.push(cents);
    }
  }

  const withoutTaxPick = pickUnique(withoutTax);
  const taxPick = pickUnique(taxes);

  return {
    ...(total.value !== undefined ? { totalCents: total.value } : {}),
    totalAmbiguous: total.ambiguous,
    ...(withoutTaxPick.value !== undefined
      ? { withoutTaxCents: withoutTaxPick.value }
      : {}),
    ...(taxPick.value !== undefined ? { taxCents: taxPick.value } : {}),
  };
}

function buildMessage(
  status: InvoiceParseStatus,
  needsReview: InvoiceFieldName[],
): string {
  if (status === 'unrecognized') {
    return '未能从文本中识别出发票信息，请手动录入。若为扫描版 PDF，当前版本暂不支持自动识别。';
  }
  if (status === 'partial') {
    const labels = needsReview.map((field) => FIELD_LABELS[field]).join('、');
    return `部分字段未识别或存在歧义，请人工核对：${labels}。`;
  }
  return '识别完成，请核对后确认保存。';
}

const FIELD_LABELS: Record<InvoiceFieldName, string> = {
  invoiceNumber: '发票号码',
  issuedAt: '开票日期',
  sellerName: '销售方名称',
  totalCents: '价税合计',
};

const ALL_FIELDS: readonly InvoiceFieldName[] = [
  'invoiceNumber',
  'issuedAt',
  'sellerName',
  'totalCents',
];

/**
 * 解析发票文本，返回结构化识别结果。
 *
 * 该函数是纯函数：同样的输入永远得到同样的输出，且不产生任何副作用。
 */
export function parseInvoiceText(input: string): InvoiceParseResult {
  const text = normalizeText(typeof input === 'string' ? input : '');
  const fields: ParsedInvoiceFields = {};
  const recognized: InvoiceFieldName[] = [];
  const needsReview: InvoiceFieldName[] = [];

  if (text.trim() === '') {
    return {
      status: 'unrecognized',
      fields,
      recognized,
      needsReview: [...ALL_FIELDS],
      message: buildMessage('unrecognized', [...ALL_FIELDS]),
    };
  }

  const invoiceNumber = parseInvoiceNumber(text);
  if (invoiceNumber.value !== undefined) {
    fields.invoiceNumber = invoiceNumber.value;
    recognized.push('invoiceNumber');
  } else {
    needsReview.push('invoiceNumber');
  }

  const issuedAt = parseIssuedAt(text);
  if (issuedAt.value !== undefined) {
    fields.issuedAt = issuedAt.value;
    recognized.push('issuedAt');
  } else {
    needsReview.push('issuedAt');
  }

  const sellerName = parseSellerName(text);
  if (sellerName.value !== undefined) {
    fields.sellerName = sellerName.value;
    recognized.push('sellerName');
  } else {
    needsReview.push('sellerName');
  }

  const amounts = parseAmounts(text);
  if (amounts.withoutTaxCents !== undefined) {
    fields.amountWithoutTaxCents = amounts.withoutTaxCents;
  }
  if (amounts.taxCents !== undefined) {
    fields.taxCents = amounts.taxCents;
  }
  if (amounts.totalCents !== undefined) {
    fields.totalCents = amounts.totalCents;
    recognized.push('totalCents');
  } else {
    // 金额缺失或歧义时保持 undefined，绝不填 0。
    needsReview.push('totalCents');
  }

  const status: InvoiceParseStatus =
    recognized.length === 0
      ? 'unrecognized'
      : needsReview.length === 0
        ? 'parsed'
        : 'partial';

  return {
    status,
    fields,
    recognized,
    needsReview,
    message: buildMessage(status, needsReview),
  };
}
