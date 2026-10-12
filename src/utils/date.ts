/**
 * 日期工具：统一使用 YYYY-MM-DD 字符串在业务层传递日期，
 * 避免时区导致的「差一天」问题。
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 是否为合法的 YYYY-MM-DD 字符串。 */
export function isDateString(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toDateString(parsed) === value;
}

/** 将 Date 转为 YYYY-MM-DD（按 UTC 计算，保证往返一致）。 */
export function toDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 解析 YYYY-MM-DD 为 UTC 零点的 Date；非法输入返回 null。 */
export function parseDateString(value: string): Date | null {
  if (!isDateString(value)) {
    return null;
  }
  return new Date(`${value}T00:00:00Z`);
}

/**
 * 计算两个日期之间的天数（含首尾），例如 10-01 到 10-03 返回 3。
 * 任一日期非法时返回 null。
 */
export function daysInclusive(start: string, end: string): number | null {
  const startDate = parseDateString(start);
  const endDate = parseDateString(end);
  if (!startDate || !endDate) {
    return null;
  }
  const diff = endDate.getTime() - startDate.getTime();
  if (diff < 0) {
    return null;
  }
  return Math.round(diff / 86_400_000) + 1;
}

/** 格式化为「2026年10月9日」样式的可读日期。非法输入返回原始字符串。 */
export function formatDisplayDate(value: string): string {
  const date = parseDateString(value);
  if (!date) {
    return value;
  }
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}
