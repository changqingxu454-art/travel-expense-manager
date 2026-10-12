import type { MealBudget, Result, Trip, TripInput } from '../../types';
import {
  calculateMealBudget,
  formatCentsAsYuan,
  parseYuanToCents,
} from '../../utils/budget';
import { AppError, fail, ok } from '../../utils/errors';

// 保留原有导出路径，金额格式化已统一收敛到 utils/budget。
export { formatCentsAsYuan };

/** 表单中全部字段以字符串保存，提交时再归一化为 {@link TripInput}。 */
export interface TripFormValues {
  name: string;
  startDate: string;
  endDate: string;
  mealsPerDay: string;
  mealStandardYuan: string;
}

/** 新建表单的默认值：每日两餐、每餐 25 元。 */
export function createDefaultTripFormValues(): TripFormValues {
  return {
    name: '',
    startDate: '',
    endDate: '',
    mealsPerDay: '2',
    mealStandardYuan: '25',
  };
}

/** 由已有记录回填编辑表单。 */
export function toTripFormValues(trip: Trip): TripFormValues {
  return {
    name: trip.name,
    startDate: trip.startDate,
    endDate: trip.endDate,
    mealsPerDay: String(trip.mealsPerDay),
    mealStandardYuan: formatCentsAsYuan(trip.mealStandardCents),
  };
}

/**
 * 校验已归一化的输入（服务层与表单层共用同一套规则）。
 * 通过后返回去除首尾空格的输入副本。
 */
export function validateTripInput(input: TripInput): Result<TripInput> {
  const name = input.name.trim();
  if (name === '') {
    return fail(new AppError('INVALID_NAME', '请填写出差名称。'));
  }

  const budget = calculateMealBudget({
    startDate: input.startDate,
    endDate: input.endDate,
    mealsPerDay: input.mealsPerDay,
    mealStandardCents: input.mealStandardCents,
  });
  if (!budget.ok) {
    return fail(new AppError(budget.error.code, budget.error.message));
  }

  return ok({ ...input, name });
}

/** 将表单字符串解析并校验为 {@link TripInput}。 */
export function parseTripFormValues(values: TripFormValues): Result<TripInput> {
  const name = values.name.trim();
  if (name === '') {
    return fail(new AppError('INVALID_NAME', '请填写出差名称。'));
  }

  const mealsRaw = values.mealsPerDay.trim();
  if (!/^\d+$/.test(mealsRaw)) {
    return fail(new AppError('INVALID_MEALS', '每日餐数必须是不小于 0 的整数。'));
  }

  const amount = parseYuanToCents(values.mealStandardYuan);
  if (!amount.ok) {
    return fail(new AppError(amount.error.code, amount.error.message));
  }

  return validateTripInput({
    name,
    startDate: values.startDate,
    endDate: values.endDate,
    mealsPerDay: Number(mealsRaw),
    mealStandardCents: amount.value,
  });
}

/** 计算某条出差记录的餐补额度，供页面展示。 */
export function calculateTripBudget(trip: Trip): Result<MealBudget> {
  return calculateMealBudget({
    startDate: trip.startDate,
    endDate: trip.endDate,
    mealsPerDay: trip.mealsPerDay,
    mealStandardCents: trip.mealStandardCents,
  });
}
