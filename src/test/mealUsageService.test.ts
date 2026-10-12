import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cents, Invoice, InvoiceInput, Trip } from '../types';
import { closeDatabase, deleteDatabase } from '../services/db';
import {
  countsTowardMealUsage,
  getMealUsageSummary,
  listMealUsageSummaries,
  sumInvoiceAmount,
} from '../services/budgetService';
import {
  createInvoice,
  linkInvoiceToTrip,
  removeInvoice,
  unlinkInvoiceFromTrip,
  updateInvoice,
} from '../services/invoiceService';
import { createTrip, updateTrip } from '../services/tripService';
import { summarizeMealUsage } from '../utils/budget';

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

/** 允许显式传 undefined 以测试「字段缺失」的场景（exactOptionalPropertyTypes）。 */
type InvoiceOverrides = {
  [K in keyof InvoiceInput]?: InvoiceInput[K] | undefined;
};

function invoiceInput(overrides: InvoiceOverrides = {}): InvoiceInput {
  const base: InvoiceOverrides = {
    invoiceNumber: '12345678',
    issuedAt: '2026-03-02',
    sellerName: '某某餐饮有限公司',
    amountCents: 5000,
    category: 'meal',
    status: 'confirmed',
    fileName: '',
    mimeType: '',
    size: 0,
    source: 'manual',
    ...overrides,
  };
  return {
    category: base.category ?? 'other',
    status: base.status ?? 'pending',
    fileName: base.fileName ?? '',
    mimeType: base.mimeType ?? '',
    size: base.size ?? 0,
    source: base.source ?? 'manual',
    ...(base.invoiceNumber !== undefined
      ? { invoiceNumber: base.invoiceNumber }
      : {}),
    ...(base.issuedAt !== undefined ? { issuedAt: base.issuedAt } : {}),
    ...(base.sellerName !== undefined ? { sellerName: base.sellerName } : {}),
    ...(base.amountCents !== undefined ? { amountCents: base.amountCents } : {}),
    ...(base.tripId !== undefined ? { tripId: base.tripId } : {}),
  };
}

/** 3 天 × 2 餐 × 25 元 = 15000 分。 */
function tripInput(name = '北京出差') {
  return {
    name,
    startDate: '2026-03-01',
    endDate: '2026-03-03',
    mealsPerDay: 2,
    mealStandardCents: 2500,
  };
}

describe('summarizeMealUsage（纯计算）', () => {
  it('未超额时剩余为预算减已用，超额金额为 0', () => {
    const usage = summarizeMealUsage(15000, 4000);
    expect(usage).toEqual({
      budgetCents: 15000,
      usedCents: 4000,
      remainingCents: 11000,
      isOverBudget: false,
      overBudgetCents: 0,
      usagePercent: 27,
    });
  });

  it('恰好用满时剩余为 0，不算超额', () => {
    const usage = summarizeMealUsage(15000, 15000);
    expect(usage.remainingCents).toBe(0);
    expect(usage.isOverBudget).toBe(false);
    expect(usage.overBudgetCents).toBe(0);
    expect(usage.usagePercent).toBe(100);
  });

  it('超额时保留负数剩余，并单独给出超额金额', () => {
    const usage = summarizeMealUsage(15000, 18500);
    expect(usage.remainingCents).toBe(-3500);
    expect(usage.isOverBudget).toBe(true);
    expect(usage.overBudgetCents).toBe(3500);
    // 展示用比例截断到 100%，避免进度条破坏布局。
    expect(usage.usagePercent).toBe(100);
  });

  it('预算为 0 时不产生 NaN 或除以零', () => {
    const zero = summarizeMealUsage(0, 0);
    expect(zero.usagePercent).toBe(0);
    expect(zero.remainingCents).toBe(0);
    expect(zero.isOverBudget).toBe(false);

    const overZero = summarizeMealUsage(0, 1200);
    expect(overZero.usagePercent).toBe(0);
    expect(overZero.isOverBudget).toBe(true);
    expect(overZero.overBudgetCents).toBe(1200);
    expect(Number.isNaN(overZero.usagePercent)).toBe(false);
  });
});

describe('餐补统计规则（服务层）', () => {
  let trip: Trip;

  beforeEach(async () => {
    await resetDatabase();
    trip = await createTrip(tripInput());
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('没有发票时已使用为 0，预算为 3 天 × 2 餐 × 25 元', async () => {
    const usage = await getMealUsageSummary(trip.id);
    expect(usage.budgetCents).toBe(15000);
    expect(usage.usedCents).toBe(0);
    expect(usage.remainingCents).toBe(15000);
    expect(usage.isOverBudget).toBe(false);
    expect(usage.overBudgetCents).toBe(0);
  });

  it('一张已确认的餐饮发票正确计入', async () => {
    const invoice = await createInvoice(invoiceInput({ amountCents: 3200 }));
    await linkInvoiceToTrip(invoice.id, trip.id);

    const usage = await getMealUsageSummary(trip.id);
    expect(usage.usedCents).toBe(3200);
    expect(usage.remainingCents).toBe(11800);
  });

  it('多张已确认的餐饮发票正确求和', async () => {
    for (const amountCents of [1200, 3400, 500]) {
      const invoice = await createInvoice(invoiceInput({ amountCents }));
      await linkInvoiceToTrip(invoice.id, trip.id);
    }
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(5100);
  });

  it('待核对的餐饮发票不计入', async () => {
    const pending = await createInvoice(
      invoiceInput({ status: 'pending', amountCents: 8800 }),
    );
    await linkInvoiceToTrip(pending.id, trip.id);

    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
  });

  it('已确认的住宿发票不计入', async () => {
    const invoice = await createInvoice(
      invoiceInput({ category: 'accommodation', amountCents: 10600 }),
    );
    await linkInvoiceToTrip(invoice.id, trip.id);

    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
  });

  it('已确认的交通发票不计入', async () => {
    const invoice = await createInvoice(
      invoiceInput({ category: 'transport', amountCents: 4200 }),
    );
    await linkInvoiceToTrip(invoice.id, trip.id);

    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
  });

  it('未关联出差的餐饮发票不计入', async () => {
    await createInvoice(invoiceInput({ amountCents: 6600 }));
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
  });

  it('关联到其它出差的餐饮发票不计入', async () => {
    const other = await createTrip(tripInput('上海出差'));
    const invoice = await createInvoice(invoiceInput({ amountCents: 6600 }));
    await linkInvoiceToTrip(invoice.id, other.id);

    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
    expect((await getMealUsageSummary(other.id)).usedCents).toBe(6600);
  });

  it('已删除的发票不计入', async () => {
    const invoice = await createInvoice(invoiceInput({ amountCents: 2400 }));
    await linkInvoiceToTrip(invoice.id, trip.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(2400);

    await removeInvoice(invoice.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
  });

  it('金额求和全程使用整数分，不存在浮点误差', async () => {
    // 0.01 + 0.02 + 10.10 + 20.20 = 30.33 元 = 3033 分
    for (const amountCents of [1, 2, 1010, 2020]) {
      const invoice = await createInvoice(invoiceInput({ amountCents }));
      await linkInvoiceToTrip(invoice.id, trip.id);
    }
    const usage = await getMealUsageSummary(trip.id);
    expect(usage.usedCents).toBe(3033);
    expect(Number.isInteger(usage.usedCents)).toBe(true);
    expect(usage.remainingCents).toBe(11967);
  });

  it('出差记录不存在时明确报错，而不是返回 0 元', async () => {
    await expect(getMealUsageSummary('missing-trip')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('数据库不可用时抛出错误，绝不退化成已使用 0 元', async () => {
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
    });
    try {
      await expect(getMealUsageSummary(trip.id)).rejects.toMatchObject({
        code: 'DB_ERROR',
      });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
      });
    }
  });

  it('批量统计与单条统计结果一致，且不把别的出差混入', async () => {
    const other = await createTrip(tripInput('上海出差'));
    const first = await createInvoice(invoiceInput({ amountCents: 1000 }));
    await linkInvoiceToTrip(first.id, trip.id);
    const second = await createInvoice(invoiceInput({ amountCents: 7000 }));
    await linkInvoiceToTrip(second.id, other.id);
    const unlinked = await createInvoice(invoiceInput({ amountCents: 9000 }));
    expect(unlinked.tripId).toBeUndefined();

    const batch = await listMealUsageSummaries([trip, other]);
    expect(batch.get(trip.id)?.usedCents).toBe(1000);
    expect(batch.get(other.id)?.usedCents).toBe(7000);
    expect(batch.get(trip.id)?.remainingCents).toBe(14000);
    expect(batch.get(other.id)?.isOverBudget).toBe(false);

    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(1000);
    expect((await getMealUsageSummary(other.id)).usedCents).toBe(7000);
  });
});

describe('餐补预算边界', () => {
  let trip: Trip;

  beforeEach(async () => {
    await resetDatabase();
    trip = await createTrip(tripInput());
  });

  afterEach(async () => {
    await resetDatabase();
  });

  async function addMealInvoice(amountCents: Cents, tripId: string): Promise<void> {
    const invoice = await createInvoice(invoiceInput({ amountCents }));
    await linkInvoiceToTrip(invoice.id, tripId);
  }

  it('已使用小于预算', async () => {
    await addMealInvoice(14999, trip.id);
    const usage = await getMealUsageSummary(trip.id);
    expect(usage.remainingCents).toBe(1);
    expect(usage.isOverBudget).toBe(false);
  });

  it('已使用等于预算', async () => {
    await addMealInvoice(15000, trip.id);
    const usage = await getMealUsageSummary(trip.id);
    expect(usage.remainingCents).toBe(0);
    expect(usage.isOverBudget).toBe(false);
    expect(usage.overBudgetCents).toBe(0);
  });

  it('已使用大于预算时给出超额金额而不是把负数抹平', async () => {
    await addMealInvoice(16000, trip.id);
    const usage = await getMealUsageSummary(trip.id);
    expect(usage.remainingCents).toBe(-1000);
    expect(usage.isOverBudget).toBe(true);
    expect(usage.overBudgetCents).toBe(1000);
  });

  it('预算为零时仍有明确结果（不出现 NaN）', async () => {
    const zeroTrip = await createTrip({ ...tripInput('零预算出差'), mealsPerDay: 0 });
    await addMealInvoice(1200, zeroTrip.id);

    const usage = await getMealUsageSummary(zeroTrip.id);
    expect(usage.budgetCents).toBe(0);
    expect(usage.usedCents).toBe(1200);
    expect(usage.usagePercent).toBe(0);
    expect(usage.isOverBudget).toBe(true);
    expect(usage.overBudgetCents).toBe(1200);
  });

  it('跨月与跨年时预算天数仍然正确', async () => {
    const crossMonth = await createTrip({
      ...tripInput('跨月出差'),
      startDate: '2026-01-28',
      endDate: '2026-02-03',
    });
    expect((await getMealUsageSummary(crossMonth.id)).budgetCents).toBe(35000);

    const crossYear = await createTrip({
      ...tripInput('跨年出差'),
      startDate: '2025-12-30',
      endDate: '2026-01-02',
    });
    expect((await getMealUsageSummary(crossYear.id)).budgetCents).toBe(20000);
  });

  it('修改出差日期、每日餐数或每餐标准后预算随之更新', async () => {
    expect((await getMealUsageSummary(trip.id)).budgetCents).toBe(15000);

    await updateTrip(trip.id, { ...tripInput(), endDate: '2026-03-05' });
    expect((await getMealUsageSummary(trip.id)).budgetCents).toBe(25000);

    await updateTrip(trip.id, {
      ...tripInput(),
      endDate: '2026-03-05',
      mealsPerDay: 1,
    });
    expect((await getMealUsageSummary(trip.id)).budgetCents).toBe(12500);

    await updateTrip(trip.id, {
      ...tripInput(),
      endDate: '2026-03-05',
      mealsPerDay: 1,
      mealStandardCents: 3000,
    });
    expect((await getMealUsageSummary(trip.id)).budgetCents).toBe(15000);
  });
});

describe('发票变更后统计同步更新', () => {
  let trip: Trip;

  beforeEach(async () => {
    await resetDatabase();
    trip = await createTrip(tripInput());
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('把待核对发票确认为已确认后计入', async () => {
    const invoice = await createInvoice(
      invoiceInput({ status: 'pending', amountCents: 4500 }),
    );
    await linkInvoiceToTrip(invoice.id, trip.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);

    await updateInvoice(invoice.id, {
      ...invoiceInput({ status: 'confirmed', amountCents: 4500 }),
      tripId: trip.id,
    });
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(4500);
  });

  it('修改已确认发票的金额后统计随之变化', async () => {
    const invoice = await createInvoice(invoiceInput({ amountCents: 3000 }));
    await linkInvoiceToTrip(invoice.id, trip.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(3000);

    await updateInvoice(invoice.id, {
      ...invoiceInput({ amountCents: 8000 }),
      tripId: trip.id,
    });
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(8000);
  });

  it('把类别从餐饮改为住宿后不再计入，改回餐饮后重新计入', async () => {
    const invoice = await createInvoice(invoiceInput({ amountCents: 6000 }));
    await linkInvoiceToTrip(invoice.id, trip.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(6000);

    await updateInvoice(invoice.id, {
      ...invoiceInput({ category: 'accommodation', amountCents: 6000 }),
      tripId: trip.id,
    });
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);

    await updateInvoice(invoice.id, {
      ...invoiceInput({ category: 'meal', amountCents: 6000 }),
      tripId: trip.id,
    });
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(6000);
  });

  it('关联出差后计入，解除关联后不再计入', async () => {
    const invoice = await createInvoice(invoiceInput({ amountCents: 2500 }));
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);

    await linkInvoiceToTrip(invoice.id, trip.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(2500);

    await unlinkInvoiceFromTrip(invoice.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
  });

  it('转移出差后原出差与新出差的统计同时更新', async () => {
    const other = await createTrip(tripInput('上海出差'));
    const invoice = await createInvoice(invoiceInput({ amountCents: 4000 }));
    await linkInvoiceToTrip(invoice.id, trip.id);

    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(4000);
    expect((await getMealUsageSummary(other.id)).usedCents).toBe(0);

    await linkInvoiceToTrip(invoice.id, other.id);

    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(0);
    expect((await getMealUsageSummary(other.id)).usedCents).toBe(4000);
  });

  it('删除已确认的餐饮发票后统计更新', async () => {
    const keep = await createInvoice(invoiceInput({ amountCents: 2000 }));
    await linkInvoiceToTrip(keep.id, trip.id);
    const drop = await createInvoice(
      invoiceInput({ invoiceNumber: '87654321', amountCents: 900 }),
    );
    await linkInvoiceToTrip(drop.id, trip.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(2900);

    await removeInvoice(drop.id);
    expect((await getMealUsageSummary(trip.id)).usedCents).toBe(2000);
  });
});

describe('共享求和工具', () => {
  const baseInvoice: Invoice = {
    id: 'inv-1',
    invoiceNumber: '12345678',
    issuedAt: '2026-03-02',
    sellerName: '某某餐饮有限公司',
    amountCents: 100,
    category: 'meal',
    status: 'confirmed',
    fileName: '',
    mimeType: '',
    size: 0,
    source: 'manual',
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-03-02T00:00:00.000Z',
  };

  /** 模拟历史数据：整条记录没有 amountCents 字段（不是 0 元）。 */
  function invoiceWithoutAmount(): Invoice {
    const { amountCents: _amountCents, ...rest } = baseInvoice;
    return rest;
  }

  it('sumInvoiceAmount 只对通过条件的发票求和，并跳过未填写金额的记录', () => {
    const invoices: Invoice[] = [
      { ...baseInvoice, id: 'a', amountCents: 100 },
      { ...baseInvoice, id: 'b', amountCents: 250 },
      { ...baseInvoice, id: 'c', status: 'pending', amountCents: 999 },
      // 未填写金额：不参与合计，也绝不被当成 0 元以外的数值
      { ...invoiceWithoutAmount(), id: 'd' },
    ];

    expect(
      sumInvoiceAmount(invoices, (invoice) => invoice.status === 'confirmed'),
    ).toBe(350);
    expect(sumInvoiceAmount(invoices, () => true)).toBe(1349);
  });

  it('countsTowardMealUsage 只在三项条件同时满足时为真', () => {
    const linked: Invoice = { ...baseInvoice, tripId: 'trip-1' };

    expect(countsTowardMealUsage(linked, 'trip-1')).toBe(true);
    // 关联到别的出差
    expect(countsTowardMealUsage(linked, 'trip-2')).toBe(false);
    // 未关联出差
    expect(countsTowardMealUsage(baseInvoice, 'trip-1')).toBe(false);
    // 待核对
    expect(countsTowardMealUsage({ ...linked, status: 'pending' }, 'trip-1')).toBe(
      false,
    );
    // 非餐饮类别
    expect(
      countsTowardMealUsage({ ...linked, category: 'transport' }, 'trip-1'),
    ).toBe(false);
    // 金额缺失
    expect(
      countsTowardMealUsage(
        { ...invoiceWithoutAmount(), tripId: 'trip-1' },
        'trip-1',
      ),
    ).toBe(false);
  });
});
