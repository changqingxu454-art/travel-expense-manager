import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Invoice, InvoiceInput, Trip } from '../types';
import { closeDatabase, deleteDatabase } from '../services/db';
import {
  getFinanceOverview,
  summarizeInvoiceCategories,
} from '../services/budgetService';
import {
  createInvoice,
  linkInvoiceToTrip,
  removeInvoice,
  unlinkInvoiceFromTrip,
  updateInvoice,
} from '../services/invoiceService';
import { createTrip, updateTrip } from '../services/tripService';

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

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
    ...(base.invoiceNumber !== undefined ? { invoiceNumber: base.invoiceNumber } : {}),
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

describe('summarizeInvoiceCategories（纯计算）', () => {
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

  it('空列表时各分类均为 0，合计为 0', () => {
    const result = summarizeInvoiceCategories([]);
    expect(result.confirmedTotalCents).toBe(0);
    expect(result.confirmedCount).toBe(0);
    expect(result.pendingCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.byCategory).toHaveLength(4);
    for (const entry of result.byCategory) {
      expect(entry.confirmedCents).toBe(0);
      expect(entry.confirmedCount).toBe(0);
      expect(entry.pendingCount).toBe(0);
    }
  });

  it('按类别拆分已确认金额与数量，且各分类合计等于总额', () => {
    const invoices: Invoice[] = [
      { ...baseInvoice, id: 'a', category: 'meal', amountCents: 3000 },
      { ...baseInvoice, id: 'b', category: 'accommodation', amountCents: 10600 },
      { ...baseInvoice, id: 'c', category: 'transport', amountCents: 4200 },
      { ...baseInvoice, id: 'd', category: 'other', amountCents: 500 },
      { ...baseInvoice, id: 'e', category: 'meal', amountCents: 2000 },
    ];
    const result = summarizeInvoiceCategories(invoices);

    expect(result.confirmedTotalCents).toBe(20300);
    expect(result.confirmedCount).toBe(5);

    const meal = result.byCategory.find((e) => e.category === 'meal');
    expect(meal?.confirmedCents).toBe(5000);
    expect(meal?.confirmedCount).toBe(2);

    const accommodation = result.byCategory.find(
      (e) => e.category === 'accommodation',
    );
    expect(accommodation?.confirmedCents).toBe(10600);
    expect(accommodation?.confirmedCount).toBe(1);

    // 各分类合计恒等于同范围已确认合计
    const sumOfCategories = result.byCategory.reduce(
      (sum, entry) => sum + entry.confirmedCents,
      0,
    );
    expect(sumOfCategories).toBe(result.confirmedTotalCents);
  });

  it('待核对只计数量不计金额，识别失败单独计数', () => {
    const invoices: Invoice[] = [
      { ...baseInvoice, id: 'a', status: 'pending', category: 'meal', amountCents: 900 },
      { ...baseInvoice, id: 'b', status: 'failed', category: 'meal' },
      { ...baseInvoice, id: 'c', status: 'confirmed', category: 'meal', amountCents: 100 },
    ];
    const result = summarizeInvoiceCategories(invoices);

    expect(result.pendingCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.confirmedCount).toBe(1);
    expect(result.confirmedTotalCents).toBe(100);
    // 待核对发票虽然填了金额，但不计入金额合计
    expect(
      result.byCategory.find((e) => e.category === 'meal')?.confirmedCents,
    ).toBe(100);
    expect(
      result.byCategory.find((e) => e.category === 'meal')?.pendingCount,
    ).toBe(1);
  });

  it('金额缺失的已确认发票计入数量但不计入金额', () => {
    const { amountCents: _a, ...withoutAmount } = baseInvoice;
    const invoices: Invoice[] = [
      { ...withoutAmount, id: 'a', status: 'confirmed', category: 'meal' },
    ];
    const result = summarizeInvoiceCategories(invoices);
    const meal = result.byCategory.find((e) => e.category === 'meal');
    expect(meal?.confirmedCount).toBe(1);
    expect(meal?.confirmedCents).toBe(0);
    expect(result.confirmedTotalCents).toBe(0);
  });
});

describe('getFinanceOverview（服务层）', () => {
  let trip: Trip;

  beforeEach(async () => {
    await resetDatabase();
    trip = await createTrip(tripInput());
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('没有出差和发票时返回空总览（金额 0、数量 0）', async () => {
    await resetDatabase();
    const overview = await getFinanceOverview();
    expect(overview.tripCount).toBe(0);
    expect(overview.budgetTotalCents).toBe(0);
    expect(overview.mealUsedTotalCents).toBe(0);
    expect(overview.mealRemainingCents).toBe(0);
    expect(overview.confirmedInvoiceTotalCents).toBe(0);
    expect(overview.pendingInvoiceCount).toBe(0);
    expect(overview.failedInvoiceCount).toBe(0);
  });

  it('汇总多条出差的预算，已使用金额复用餐补口径', async () => {
    await createTrip(tripInput('上海出差'));
    // 只计入 trip 的餐饮发票
    const meal = await createInvoice(invoiceInput({ amountCents: 3200 }));
    await linkInvoiceToTrip(meal.id, trip.id);

    const overview = await getFinanceOverview();
    // 两条出差，各 15000 分预算
    expect(overview.tripCount).toBe(2);
    expect(overview.budgetTotalCents).toBe(30000);
    expect(overview.mealUsedTotalCents).toBe(3200);
    expect(overview.mealRemainingCents).toBe(26800);
  });

  it('已确认发票合计含全部类别，与餐补口径相互独立', async () => {
    await createInvoice(invoiceInput({ amountCents: 3000, category: 'meal' }));
    await createInvoice(
      invoiceInput({ amountCents: 10600, category: 'accommodation' }),
    );
    await createInvoice(
      invoiceInput({ amountCents: 4200, category: 'transport' }),
    );
    // 待核对不计入
    await createInvoice(
      invoiceInput({ amountCents: 5000, status: 'pending', category: 'meal' }),
    );
    // 识别失败不计入
    await createInvoice(
      invoiceInput({ status: 'failed', category: 'meal', amountCents: undefined }),
    );

    const overview = await getFinanceOverview();
    expect(overview.confirmedInvoiceTotalCents).toBe(3000 + 10600 + 4200);
    expect(overview.pendingInvoiceCount).toBe(1);
    expect(overview.failedInvoiceCount).toBe(1);
    // 未关联出差的餐饮发票不计入餐补已使用
    expect(overview.mealUsedTotalCents).toBe(0);
  });

  it('餐补已使用严格遵循 budgetService 口径（待核对、非餐饮、未关联都不计入）', async () => {
    // 关联到 trip 的餐饮已确认发票：计入
    const meal = await createInvoice(invoiceInput({ amountCents: 2000 }));
    await linkInvoiceToTrip(meal.id, trip.id);
    // 关联到 trip 的住宿已确认发票：不计入餐补，但计入已确认合计
    const hotel = await createInvoice(
      invoiceInput({ amountCents: 10600, category: 'accommodation' }),
    );
    await linkInvoiceToTrip(hotel.id, trip.id);
    // 关联到 trip 的待核对餐饮发票：不计入
    await createInvoice(
      invoiceInput({ amountCents: 900, status: 'pending' }),
    );
    // 未关联出差的餐饮发票：不计入
    await createInvoice(invoiceInput({ amountCents: 700 }));

    const overview = await getFinanceOverview();
    expect(overview.mealUsedTotalCents).toBe(2000);
    expect(overview.confirmedInvoiceTotalCents).toBe(2000 + 10600 + 700);
  });

  it('改金额/类别/状态、解除关联、删除后统计正确更新', async () => {
    const invoice = await createInvoice(invoiceInput({ amountCents: 5000 }));
    await linkInvoiceToTrip(invoice.id, trip.id);
    expect((await getFinanceOverview()).mealUsedTotalCents).toBe(5000);

    // 改金额
    await updateInvoice(invoice.id, {
      ...invoiceInput({ amountCents: 8000 }),
      tripId: trip.id,
    });
    expect((await getFinanceOverview()).mealUsedTotalCents).toBe(8000);

    // 改类别为住宿：餐补归零，但已确认合计不变
    await updateInvoice(invoice.id, {
      ...invoiceInput({ amountCents: 8000, category: 'accommodation' }),
      tripId: trip.id,
    });
    const afterCategory = await getFinanceOverview();
    expect(afterCategory.mealUsedTotalCents).toBe(0);
    expect(afterCategory.confirmedInvoiceTotalCents).toBe(8000);

    // 改回餐饮并解除关联：餐补归零
    await updateInvoice(invoice.id, {
      ...invoiceInput({ amountCents: 8000, category: 'meal' }),
      tripId: trip.id,
    });
    await unlinkInvoiceFromTrip(invoice.id);
    expect((await getFinanceOverview()).mealUsedTotalCents).toBe(0);

    // 删除后已确认合计归零
    await removeInvoice(invoice.id);
    expect((await getFinanceOverview()).confirmedInvoiceTotalCents).toBe(0);
  });

  it('修改出差日期/餐数/餐标后预算总额随之更新', async () => {
    expect((await getFinanceOverview()).budgetTotalCents).toBe(15000);
    await updateTrip(trip.id, { ...tripInput(), endDate: '2026-03-05' });
    // 5 天 × 2 餐 × 25 元 = 25000 分
    expect((await getFinanceOverview()).budgetTotalCents).toBe(25000);
  });

  it('数据库不可用时抛出错误，绝不返回伪造的零金额', async () => {
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
    });
    try {
      await expect(getFinanceOverview()).rejects.toMatchObject({
        code: 'DB_ERROR',
      });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
      });
    }
  });
});
