import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEAL_STANDARD_CENTS,
  DEFAULT_MEALS_PER_DAY,
  calculateMealBudget,
  formatCents,
  parseYuanToCents,
} from '../utils/budget';

describe('formatCents', () => {
  it('将「分」格式化为人民币金额', () => {
    expect(formatCents(0)).toBe('¥0.00');
    expect(formatCents(5)).toBe('¥0.05');
    expect(formatCents(123456)).toBe('¥1,234.56');
  });

  it('支持负数金额', () => {
    expect(formatCents(-500)).toBe('-¥5.00');
  });

  it('可以省略货币符号', () => {
    expect(formatCents(123456, { withSymbol: false })).toBe('1,234.56');
  });

  it('非法输入返回占位符', () => {
    expect(formatCents(Number.NaN)).toBe('--');
  });
});

describe('parseYuanToCents', () => {
  it('解析整数与最多两位小数', () => {
    expect(parseYuanToCents('25')).toEqual({ ok: true, value: 2500 });
    expect(parseYuanToCents('25.5')).toEqual({ ok: true, value: 2550 });
    expect(parseYuanToCents('25.50')).toEqual({ ok: true, value: 2550 });
    expect(parseYuanToCents('0')).toEqual({ ok: true, value: 0 });
  });

  it('去除首尾空格', () => {
    expect(parseYuanToCents('  12.34  ')).toEqual({ ok: true, value: 1234 });
  });

  it('拒绝空值、负数、超过两位小数与非数字', () => {
    expect(parseYuanToCents('').ok).toBe(false);
    expect(parseYuanToCents('-1').ok).toBe(false);
    expect(parseYuanToCents('1.234').ok).toBe(false);
    expect(parseYuanToCents('abc').ok).toBe(false);
    expect(parseYuanToCents('1e3').ok).toBe(false);
  });
});

describe('calculateMealBudget', () => {
  it('1 天、每天 2 餐、每餐 25 元 → 5000 分', () => {
    const result = calculateMealBudget({
      startDate: '2026-03-01',
      endDate: '2026-03-01',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        days: 1,
        mealsPerDay: 2,
        mealStandardCents: 2500,
        totalCents: 5000,
      },
    });
  });

  it('10 天、每天 2 餐、每餐 25 元 → 50000 分', () => {
    const result = calculateMealBudget({
      startDate: '2026-03-01',
      endDate: '2026-03-10',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    expect(result.ok && result.value.totalCents).toBe(50000);
    expect(result.ok && result.value.days).toBe(10);
  });

  it('缺少餐数与标准时使用默认值（2 餐 / 25 元）', () => {
    const result = calculateMealBudget({
      startDate: '2026-03-01',
      endDate: '2026-03-01',
    });
    expect(result.ok && result.value.mealsPerDay).toBe(DEFAULT_MEALS_PER_DAY);
    expect(result.ok && result.value.mealStandardCents).toBe(
      DEFAULT_MEAL_STANDARD_CENTS,
    );
    expect(result.ok && result.value.totalCents).toBe(5000);
  });

  it('跨月日期首尾均计入（1/28–2/3 → 7 天）', () => {
    const result = calculateMealBudget({
      startDate: '2026-01-28',
      endDate: '2026-02-03',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    expect(result.ok && result.value.days).toBe(7);
    expect(result.ok && result.value.totalCents).toBe(35000);
  });

  it('跨年日期首尾均计入（2025-12-30–2026-01-02 → 4 天）', () => {
    const result = calculateMealBudget({
      startDate: '2025-12-30',
      endDate: '2026-01-02',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    expect(result.ok && result.value.days).toBe(4);
    expect(result.ok && result.value.totalCents).toBe(20000);
  });

  it('闰年 2 月按 29 天计算（2024-02-28–2024-03-01 → 3 天）', () => {
    const result = calculateMealBudget({
      startDate: '2024-02-28',
      endDate: '2024-03-01',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    expect(result.ok && result.value.days).toBe(3);
    expect(result.ok && result.value.totalCents).toBe(15000);
  });

  it('开始日期等于结束日期视为 1 天', () => {
    const result = calculateMealBudget({
      startDate: '2026-06-15',
      endDate: '2026-06-15',
      mealsPerDay: 3,
      mealStandardCents: 1000,
    });
    expect(result.ok && result.value.days).toBe(1);
    expect(result.ok && result.value.totalCents).toBe(3000);
  });

  it('结束日期早于开始日期时返回错误', () => {
    const result = calculateMealBudget({
      startDate: '2026-03-05',
      endDate: '2026-03-01',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_DATE_RANGE');
  });

  it('非法日期返回错误', () => {
    for (const [start, end] of [
      ['not-a-date', '2026-03-01'],
      ['2026-03-01', '2026-13-01'],
      ['2026-02-30', '2026-03-01'],
      ['2026-3-1', '2026-03-01'],
    ] as const) {
      const result = calculateMealBudget({ startDate: start, endDate: end });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('INVALID_DATE');
    }
  });

  it('每日餐数为 0 时额度为 0', () => {
    const result = calculateMealBudget({
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      mealsPerDay: 0,
      mealStandardCents: 2500,
    });
    expect(result.ok && result.value.totalCents).toBe(0);
  });

  it('每日餐数为负数或非整数时返回错误', () => {
    for (const mealsPerDay of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = calculateMealBudget({
        startDate: '2026-03-01',
        endDate: '2026-03-03',
        mealsPerDay,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('INVALID_MEALS');
    }
  });

  it('每餐标准为负数、非有限值或非整数分时返回错误', () => {
    for (const mealStandardCents of [
      -100,
      2500.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const result = calculateMealBudget({
        startDate: '2026-03-01',
        endDate: '2026-03-03',
        mealStandardCents,
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('INVALID_MEAL_STANDARD');
    }
  });

  it('结果超出安全整数范围时返回错误', () => {
    const result = calculateMealBudget({
      startDate: '2026-01-01',
      endDate: '2026-01-03',
      mealsPerDay: Number.MAX_SAFE_INTEGER,
      mealStandardCents: 2500,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('BUDGET_OVERFLOW');
  });
});
