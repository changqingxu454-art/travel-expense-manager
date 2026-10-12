import type {
  Cents,
  Invoice,
  InvoiceCategory,
  InvoiceStatus,
  MealUsageSummary,
  Trip,
} from '../types';
import { INVOICE_CATEGORIES } from '../types';
import { calculateMealBudget, summarizeMealUsage } from '../utils/budget';
import { AppError } from '../utils/errors';
import { listInvoices } from './invoiceService';
import { getTrip, listTrips } from './tripService';

/**
 * 餐补使用统计的服务层：全应用**唯一**的统计口径。
 *
 * 已使用金额 = Σ 发票金额（分），发票需**同时**满足：
 *   1. `status === 'confirmed'`（待核对 / 识别失败的发票不计入）；
 *   2. `category === 'meal'`（住宿、交通、其他类别不计入）；
 *   3. `tripId` 与本次出差的 id 完全一致（未关联出差的发票、关联到其它出差的发票都不计入）；
 *   4. 金额为有效整数分（`confirmed` 状态在写入时已强制要求金额，缺失金额不会被按 0 元计入）。
 *
 * 其它约定：
 * - 只读取已保存的发票元数据，**不解析 PDF**。
 * - 不按文件名、销售方或发票日期猜测所属出差。
 * - 查询失败时直接向上抛出 `AppError`，绝不退化成 `usedCents = 0` 的「看似成功」结果。
 * - 不新增索引、不升级 IndexedDB 版本、不改变既有数据结构。
 */

/** 代表「餐饮」的类别值；集中定义以免各页面手写字符串。 */
export const MEAL_INVOICE_CATEGORY: InvoiceCategory = 'meal';

/** 判断一张发票是否计入某次出差的餐补已使用金额。 */
export function countsTowardMealUsage(invoice: Invoice, tripId: string): boolean {
  return (
    invoice.status === 'confirmed' &&
    invoice.category === MEAL_INVOICE_CATEGORY &&
    invoice.tripId === tripId &&
    invoice.amountCents !== undefined
  );
}

/**
 * 是否为「已确认 + 餐饮 + 已关联某次出差」的发票。
 *
 * 与 {@link countsTowardMealUsage} 同源，区别是不限定具体出差，
 * 供发票页汇总「可计入餐补的发票金额」使用。
 */
export function isConfirmedLinkedMealInvoice(invoice: Invoice): boolean {
  return (
    invoice.status === 'confirmed' &&
    invoice.category === MEAL_INVOICE_CATEGORY &&
    invoice.tripId !== undefined &&
    invoice.amountCents !== undefined
  );
}

/**
 * 汇总发票金额（整数分）。
 *
 * 只对满足 `predicate` 且已填写金额的发票求和；缺少金额的发票按未填写处理、不参与合计，
 * 绝不把缺失金额当成 0 元写进统计。
 */
export function sumInvoiceAmount(
  invoices: readonly Invoice[],
  predicate: (invoice: Invoice) => boolean,
): Cents {
  let sum = 0;
  for (const invoice of invoices) {
    const { amountCents } = invoice;
    if (predicate(invoice) && amountCents !== undefined) {
      sum += amountCents;
    }
  }
  return sum;
}

/** 对一组发票按统计口径求和（整数分运算，无浮点误差）。 */
function sumMealUsage(invoices: readonly Invoice[], tripId: string): Cents {
  return sumInvoiceAmount(invoices, (invoice) =>
    countsTowardMealUsage(invoice, tripId),
  );
}

/** 计算某次出差的餐补预算（分）；日期等数据异常时抛出带错误码的 {@link AppError}。 */
function budgetCentsOf(trip: Trip): Cents {
  const budget = calculateMealBudget({
    startDate: trip.startDate,
    endDate: trip.endDate,
    mealsPerDay: trip.mealsPerDay,
    mealStandardCents: trip.mealStandardCents,
  });
  if (!budget.ok) {
    throw new AppError(budget.error.code, budget.error.message);
  }
  return budget.value.totalCents;
}

/**
 * 单次出差的餐补统计。
 *
 * - 出差记录不存在时抛出 `NOT_FOUND`，不返回 0 元假象。
 * - 发票查询失败时原样抛出（通常为 `DB_ERROR`）。
 */
export async function getMealUsageSummary(
  tripId: string,
): Promise<MealUsageSummary> {
  if (tripId.trim() === '') {
    throw new AppError('INVALID_ID', '出差记录 ID 不能为空。');
  }
  const trip = await getTrip(tripId);
  if (!trip) {
    throw new AppError('NOT_FOUND', '出差记录不存在，可能已被删除。');
  }
  // 走 by_tripId 索引，只读取该出差关联的发票，再在内存中按统一口径筛选。
  const related = await listInvoices({ tripId });
  return summarizeMealUsage(budgetCentsOf(trip), sumMealUsage(related, tripId));
}

/**
 * 批量计算多条出差的餐补统计（列表页 / 首页使用）。
 *
 * 只发起**一次**发票查询后按 `tripId` 分组，避免逐条出差查询造成 N+1。
 * 单条出差数据异常（例如日期非法导致预算算不出来）时跳过该条，
 * 由页面按既有逻辑提示「无法计算餐补」，不影响其它出差的统计。
 */
export async function listMealUsageSummaries(
  trips: readonly Trip[],
): Promise<Map<string, MealUsageSummary>> {
  const summaries = new Map<string, MealUsageSummary>();
  if (trips.length === 0) {
    return summaries;
  }

  // 走 by_category 索引，一次拿到全部餐饮发票，再在内存中过滤状态与关联。
  const mealInvoices = await listInvoices({ category: MEAL_INVOICE_CATEGORY });
  const usedByTrip = new Map<string, Cents>();
  for (const invoice of mealInvoices) {
    const { tripId, amountCents } = invoice;
    if (tripId === undefined || amountCents === undefined) {
      continue;
    }
    if (invoice.status !== 'confirmed') {
      continue;
    }
    usedByTrip.set(tripId, (usedByTrip.get(tripId) ?? 0) + amountCents);
  }

  for (const trip of trips) {
    let budgetCents: Cents;
    try {
      budgetCents = budgetCentsOf(trip);
    } catch {
      continue;
    }
    summaries.set(
      trip.id,
      summarizeMealUsage(budgetCents, usedByTrip.get(trip.id) ?? 0),
    );
  }

  return summaries;
}

/**
 * 首页财务总览。
 *
 * 所有金额均为整数分，展示时才格式化为人民币。统计口径与详情页 / 列表页完全一致，
 * 不在这里重新实现餐补筛选规则。
 */
export interface FinanceOverview {
  /** 出差记录总数。 */
  tripCount: number;
  /** 餐补预算总额（分）：所有出差的预算之和。 */
  budgetTotalCents: Cents;
  /** 餐补已使用总额（分）：所有出差「已确认餐饮发票」之和（复用 {@link listMealUsageSummaries}）。 */
  mealUsedTotalCents: Cents;
  /** 餐补剩余总额（分）：预算 − 已使用，允许为负。 */
  mealRemainingCents: Cents;
  /** 已确认发票金额合计（分）：所有状态为 confirmed 且金额有效的发票之和，含全部类别。 */
  confirmedInvoiceTotalCents: Cents;
  /** 待核对发票数量。 */
  pendingInvoiceCount: number;
  /** 识别失败发票数量（与待核对分开统计）。 */
  failedInvoiceCount: number;
}

/**
 * 汇总所有出差的财务总览。
 *
 * 只发起一次发票查询（全量），随后在内存中完成：
 * - 餐补已使用金额：复用 {@link listMealUsageSummaries}，保证与详情页口径一致、无 N+1；
 * - 已确认金额合计：对所有已确认且金额有效的发票求和，不限于餐饮类别；
 * - 待核对 / 识别失败数量：按 `status` 区分，识别失败不混入待核对。
 *
 * 任一查询失败都原样抛出 {@link AppError}，绝不退化成 0 元假象。
 */
export async function getFinanceOverview(): Promise<FinanceOverview> {
  const [trips, invoices] = await Promise.all([listTrips(), listInvoices()]);

  const mealSummaries = await listMealUsageSummaries(trips);

  let budgetTotalCents: Cents = 0;
  let mealUsedTotalCents: Cents = 0;
  for (const summary of mealSummaries.values()) {
    budgetTotalCents += summary.budgetCents;
    mealUsedTotalCents += summary.usedCents;
  }

  const confirmedInvoiceTotalCents = sumInvoiceAmount(
    invoices,
    (invoice) => invoice.status === 'confirmed',
  );

  let pendingInvoiceCount = 0;
  let failedInvoiceCount = 0;
  for (const invoice of invoices) {
    if (invoice.status === 'pending') {
      pendingInvoiceCount += 1;
    } else if (invoice.status === 'failed') {
      failedInvoiceCount += 1;
    }
  }

  return {
    tripCount: trips.length,
    budgetTotalCents,
    mealUsedTotalCents,
    mealRemainingCents: budgetTotalCents - mealUsedTotalCents,
    confirmedInvoiceTotalCents,
    pendingInvoiceCount,
    failedInvoiceCount,
  };
}

/** 单个发票类别的分类汇总（金额 + 数量）。 */
export interface InvoiceCategorySummary {
  category: InvoiceCategory;
  /** 该类别已确认发票的金额合计（分）。 */
  confirmedCents: Cents;
  /** 该类别已确认发票的数量。 */
  confirmedCount: number;
  /** 该类别待核对发票的数量。 */
  pendingCount: number;
}

/** 发票分类汇总结果：分类明细 + 口径汇总。 */
export interface InvoiceCategoryBreakdown {
  /** 按 INVOICE_CATEGORIES 顺序排列的分类汇总。 */
  byCategory: InvoiceCategorySummary[];
  /** 已确认发票金额合计（分），与各分类 confirmedCents 之和恒等。 */
  confirmedTotalCents: Cents;
  /** 已确认发票总数量。 */
  confirmedCount: number;
  /** 待核对发票总数量。 */
  pendingCount: number;
  /** 识别失败发票总数量。 */
  failedCount: number;
}

/**
 * 对一组发票做分类汇总（纯函数，不读写数据库）。
 *
 * 口径：
 * - 已确认金额：`status === 'confirmed'` 且金额有效的发票，按类别求和；
 *   全部类别合计恒等于同范围的「已确认金额合计」。
 * - 待核对数量：`status === 'pending'`；识别失败（`failed`）单列，不混入。
 * - 分类值严格取自 `INVOICE_CATEGORIES`，不引入新类别字符串。
 * - 金额缺失的发票不参与金额合计，也不被当成 0 元。
 * - 是否关联出差**不影响**本分类统计（解除关联后类别金额不变）。
 */
export function summarizeInvoiceCategories(
  invoices: readonly Invoice[],
): InvoiceCategoryBreakdown {
  const byCategory = INVOICE_CATEGORIES.map((category) => ({
    category,
    confirmedCents: 0,
    confirmedCount: 0,
    pendingCount: 0,
  }));

  let confirmedTotalCents: Cents = 0;
  let confirmedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;

  for (const invoice of invoices) {
    const { status } = invoice;
    if (status === 'pending') {
      pendingCount += 1;
    } else if (status === 'failed') {
      failedCount += 1;
    }

    const slot = byCategory.find((entry) => entry.category === invoice.category);
    if (!slot) {
      continue;
    }
    if (status === 'pending') {
      slot.pendingCount += 1;
    }
    if (status === 'confirmed') {
      slot.confirmedCount += 1;
      if (invoice.amountCents !== undefined) {
        slot.confirmedCents += invoice.amountCents;
        confirmedTotalCents += invoice.amountCents;
      }
    }
  }

  confirmedCount = byCategory.reduce((sum, entry) => sum + entry.confirmedCount, 0);

  return {
    byCategory,
    confirmedTotalCents,
    confirmedCount,
    pendingCount,
    failedCount,
  };
}

/** 判断某状态的发票是否应计入「待核对」口径（供页面文案复用）。 */
export function isPendingStatus(status: InvoiceStatus): boolean {
  return status === 'pending';
}
