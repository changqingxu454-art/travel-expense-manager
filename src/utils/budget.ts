import type {
  Cents,
  MealBudget,
  MealBudgetInput,
  MealUsageSummary,
  Result,
} from '../types';
import { daysInclusive, isDateString } from './date';
import { AppError, fail, ok } from './errors';

/** 默认每日餐数。 */
export const DEFAULT_MEALS_PER_DAY = 2;

/** 默认每餐标准（分）：25 元。 */
export const DEFAULT_MEAL_STANDARD_CENTS: Cents = 2500;

/** 金额以「分」存储，仅做展示格式化。 */
export function formatCents(cents: Cents, options: { withSymbol?: boolean } = {}): string {
  if (!Number.isFinite(cents)) {
    return '--';
  }
  const { withSymbol = true } = options;
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  const grouped = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${grouped}.${String(fen).padStart(2, '0')}`;
  const sign = negative ? '-' : '';
  return withSymbol ? `${sign}¥${body}` : `${sign}${body}`;
}

/**
 * 将「元」字符串安全转换为整数分。
 *
 * 允许最多两位小数（如 "25"、"25.5"、"25.50"），不涉及浮点累积误差。
 * 拒绝空串、负数、超过两位小数、非数字与超出安全整数范围的值。
 */
export function parseYuanToCents(input: string): Result<Cents> {
  const trimmed = input.trim();
  if (trimmed === '') {
    return fail(new AppError('INVALID_AMOUNT', '金额不能为空。'));
  }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return fail(
      new AppError('INVALID_AMOUNT', '金额需为非负数字，且最多保留两位小数。'),
    );
  }
  const [yuanPart = '0', fenPart = ''] = trimmed.split('.');
  const yuan = Number(yuanPart);
  const fen = Number(fenPart.padEnd(2, '0'));
  const cents = yuan * 100 + fen;
  if (!Number.isSafeInteger(cents)) {
    return fail(new AppError('INVALID_AMOUNT', '金额超出可处理的范围。'));
  }
  return ok(cents);
}

/** 将整数分还原为「元」字符串（整数时不带小数），用于表单回填。 */
export function formatCentsAsYuan(cents: Cents): string {
  const yuan = Math.floor(Math.abs(cents) / 100);
  const fen = Math.abs(cents) % 100;
  const sign = cents < 0 ? '-' : '';
  return fen === 0
    ? `${sign}${yuan}`
    : `${sign}${yuan}.${String(fen).padStart(2, '0')}`;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 计算出差餐补额度（纯函数：不读写数据库、无副作用）。
 *
 * 规则：
 * - 出差天数按开始与结束日期首尾均包含计算。
 * - 每日餐数默认 {@link DEFAULT_MEALS_PER_DAY}，每餐标准默认 {@link DEFAULT_MEAL_STANDARD_CENTS}。
 * - 额度 = 天数 × 每日餐数 × 每餐标准（全程整数分运算）。
 *
 * 无效输入（非法日期、结束早于开始、负数/非整数餐数或金额、结果溢出）返回 `Result.ok === false`，
 * 不抛出异常，便于 UI 直接展示错误信息。
 */
export function calculateMealBudget(input: MealBudgetInput): Result<MealBudget> {
  const { startDate, endDate } = input;
  const mealsPerDay = input.mealsPerDay ?? DEFAULT_MEALS_PER_DAY;
  const mealStandardCents =
    input.mealStandardCents ?? DEFAULT_MEAL_STANDARD_CENTS;

  if (!isDateString(startDate) || !isDateString(endDate)) {
    return fail(new AppError('INVALID_DATE', '开始或结束日期不是合法日期。'));
  }

  // daysInclusive 使用 UTC 时间戳计算，不受本地时区与夏令时影响。
  const days = daysInclusive(startDate, endDate);
  if (days === null) {
    return fail(new AppError('INVALID_DATE_RANGE', '结束日期不能早于开始日期。'));
  }

  if (!isNonNegativeInteger(mealsPerDay)) {
    return fail(new AppError('INVALID_MEALS', '每日餐数必须是不小于 0 的整数。'));
  }

  if (!isNonNegativeInteger(mealStandardCents)) {
    return fail(
      new AppError('INVALID_MEAL_STANDARD', '每餐标准必须是不小于 0 的整数分。'),
    );
  }

  const totalCents = days * mealsPerDay * mealStandardCents;
  if (!Number.isSafeInteger(totalCents)) {
    return fail(new AppError('BUDGET_OVERFLOW', '餐补额度超出可安全计算的范围。'));
  }

  return ok({ days, mealsPerDay, mealStandardCents, totalCents });
}

/**
 * 由「餐补预算」与「已使用金额」推导出剩余、超额与展示用比例（纯函数，无副作用）。
 *
 * 规则：
 * - 入参均为不小于 0 的整数分（由 {@link calculateMealBudget} 与发票金额校验保证）。
 * - 剩余金额允许为负数，超额金额单独给出，**不会**把负数改写成 0 而隐藏超额。
 * - 预算为 0 时比例为 0，不出现除以零或 NaN；比例上限截断到 100 以免破坏布局。
 */
export function summarizeMealUsage(
  budgetCents: Cents,
  usedCents: Cents,
): MealUsageSummary {
  const remainingCents = budgetCents - usedCents;
  const isOverBudget = remainingCents < 0;
  const usagePercent =
    budgetCents > 0
      ? Math.min(100, Math.round((usedCents / budgetCents) * 100))
      : 0;

  return {
    budgetCents,
    usedCents,
    remainingCents,
    isOverBudget,
    overBudgetCents: isOverBudget ? -remainingCents : 0,
    usagePercent,
  };
}
