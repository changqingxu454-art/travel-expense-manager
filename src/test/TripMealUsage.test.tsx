import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TripDetail from '../pages/TripDetail';
import { closeDatabase, deleteDatabase } from '../services/db';
import {
  createInvoice,
  linkInvoiceToTrip,
  removeInvoice,
  unlinkInvoiceFromTrip,
  updateInvoice,
} from '../services/invoiceService';
import { createTrip } from '../services/tripService';
import type { InvoiceInput, TripInput } from '../types';

/**
 * 通过可控开关模拟「餐补统计查询失败」。
 * 用 vi.hoisted 保证开关在 vi.mock 工厂执行前就已初始化。
 */
const flags = vi.hoisted(() => ({ failUsageQuery: false }));

vi.mock('../services/budgetService', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../services/budgetService')>();
  return {
    ...actual,
    getMealUsageSummary: async (tripId: string) => {
      if (flags.failUsageQuery) {
        throw new Error('模拟统计查询失败');
      }
      return actual.getMealUsageSummary(tripId);
    },
  };
});

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

/** 3 天 × 2 餐 × 25 元 = 15000 分 = ¥150.00。 */
function baseTripInput(name = '北京出差'): TripInput {
  return {
    name,
    startDate: '2026-03-01',
    endDate: '2026-03-03',
    mealsPerDay: 2,
    mealStandardCents: 2500,
  };
}

/** 一张手工录入的餐饮发票（默认已确认，便于直接参与统计）。 */
function mealInvoiceInput(
  amountCents: number,
  overrides: Partial<InvoiceInput> = {},
): InvoiceInput {
  return {
    amountCents,
    category: 'meal',
    status: 'confirmed',
    fileName: '',
    mimeType: '',
    size: 0,
    source: 'manual',
    ...overrides,
  };
}

/** 读取「标签 → 值」形式的摘要项（dt/dd）文本。 */
function summaryValue(label: string): string {
  const labelEl = screen.getByText(label);
  const item = labelEl.closest('.summary__item');
  if (!item) {
    throw new Error(`未找到摘要项：${label}`);
  }
  return item.querySelector('.summary__value')?.textContent ?? '';
}

/** 渲染详情页并等待全部本地读取完成（含餐补统计）。 */
async function renderDetail(tripId: string) {
  const view = render(<TripDetail tripId={tripId} />);
  await waitFor(() =>
    expect(screen.queryByText('正在读取本地数据…')).not.toBeInTheDocument(),
  );
  return view;
}

describe('出差详情页的餐补统计', () => {
  beforeEach(async () => {
    flags.failUsageQuery = false;
    await resetDatabase();
  });

  afterEach(async () => {
    flags.failUsageQuery = false;
    await resetDatabase();
  });

  it('展示真实的预算、已使用、剩余与已使用比例', async () => {
    const trip = await createTrip(baseTripInput());
    const invoice = await createInvoice(mealInvoiceInput(3200));
    await linkInvoiceToTrip(invoice.id, trip.id);

    await renderDetail(trip.id);

    expect(summaryValue('餐补总额度')).toBe('¥150.00');
    expect(summaryValue('已使用金额')).toBe('¥32.00');
    expect(summaryValue('剩余额度')).toBe('¥118.00');
    // 3200 / 15000 ≈ 21.33% → 21%
    expect(summaryValue('已使用比例')).toBe('21%');

    const bar = screen.getByRole('progressbar', { name: '餐补已使用比例' });
    expect(bar).toHaveAttribute('aria-valuenow', '21');
    // 该发票确实参与了统计
    expect(screen.getByText('计入餐补已使用金额')).toBeInTheDocument();
  });

  it('超额时显示超额金额与提示，进度条不超过 100%', async () => {
    const trip = await createTrip(baseTripInput());
    const invoice = await createInvoice(mealInvoiceInput(18000));
    await linkInvoiceToTrip(invoice.id, trip.id);

    await renderDetail(trip.id);

    expect(summaryValue('超出额度')).toBe('¥30.00');
    expect(screen.queryByText('剩余额度')).not.toBeInTheDocument();
    expect(screen.getByText(/已超出餐补额度 ¥30\.00/)).toBeInTheDocument();

    const bar = screen.getByRole('progressbar', { name: '餐补已使用比例' });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
  });

  it('待核对、非餐饮类别与未关联的发票都不计入', async () => {
    const trip = await createTrip(baseTripInput());
    await createInvoice(
      mealInvoiceInput(5000, { status: 'pending', tripId: trip.id }),
    );
    const hotel = await createInvoice(
      mealInvoiceInput(10600, { category: 'accommodation' }),
    );
    await linkInvoiceToTrip(hotel.id, trip.id);
    await createInvoice(mealInvoiceInput(8800));

    await renderDetail(trip.id);

    expect(summaryValue('已使用金额')).toBe('¥0.00');
    expect(summaryValue('剩余额度')).toBe('¥150.00');
    expect(summaryValue('已使用比例')).toBe('0%');
    expect(screen.getAllByText('不计入餐补')).toHaveLength(2);
  });

  it('修改出差日期后预算与统计一起更新', async () => {
    const trip = await createTrip(baseTripInput());
    await renderDetail(trip.id);
    expect(summaryValue('餐补总额度')).toBe('¥150.00');

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByText('编辑出差');
    fireEvent.change(screen.getByLabelText('结束日期'), {
      target: { value: '2026-03-05' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.queryByText('编辑出差')).not.toBeInTheDocument());
    // 5 天 × 2 餐 × 25 元 = 25000 分
    await waitFor(() => expect(summaryValue('餐补总额度')).toBe('¥250.00'));
    expect(summaryValue('剩余额度')).toBe('¥250.00');
  });

  it('统计查询失败时明确展示错误，而不是静默显示 ¥0.00', async () => {
    const trip = await createTrip(baseTripInput());
    flags.failUsageQuery = true;

    await renderDetail(trip.id);

    expect(screen.getByText(/读取餐补使用情况失败/)).toBeInTheDocument();
    // 预算仍然展示，但绝不显示「已使用 ¥0.00」这类误导数据
    expect(summaryValue('餐补总额度')).toBe('¥150.00');
    expect(screen.queryByText('¥0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('已使用金额')).not.toBeInTheDocument();
  });

  it('发票在别处被确认 / 转移 / 解除关联 / 删除后，重新进入页面统计一致', async () => {
    const trip = await createTrip(baseTripInput());
    const other = await createTrip(baseTripInput('上海出差'));

    // 初始：一张待核对且未关联的发票，不计入任何出差
    const invoice = await createInvoice(
      mealInvoiceInput(5000, { status: 'pending' }),
    );
    const initial = await renderDetail(trip.id);
    expect(summaryValue('已使用金额')).toBe('¥0.00');
    initial.unmount();

    // 1) 在发票页确认并关联到本次出差
    await updateInvoice(invoice.id, {
      ...mealInvoiceInput(5000),
      tripId: trip.id,
    });
    const afterConfirm = await renderDetail(trip.id);
    expect(summaryValue('已使用金额')).toBe('¥50.00');
    expect(screen.getByText('计入餐补已使用金额')).toBeInTheDocument();
    afterConfirm.unmount();

    // 2) 转移到另一次出差：原出差归零，新出差拿到金额
    await linkInvoiceToTrip(invoice.id, other.id);
    const afterTransfer = await renderDetail(trip.id);
    expect(summaryValue('已使用金额')).toBe('¥0.00');
    afterTransfer.unmount();
    const otherView = await renderDetail(other.id);
    expect(summaryValue('已使用金额')).toBe('¥50.00');
    otherView.unmount();

    // 3) 解除关联后不再计入
    await unlinkInvoiceFromTrip(invoice.id);
    const afterUnlink = await renderDetail(other.id);
    expect(summaryValue('已使用金额')).toBe('¥0.00');
    afterUnlink.unmount();

    // 4) 重新关联后删除发票，统计再次归零
    await linkInvoiceToTrip(invoice.id, trip.id);
    const relinked = await renderDetail(trip.id);
    expect(summaryValue('已使用金额')).toBe('¥50.00');
    relinked.unmount();

    await removeInvoice(invoice.id);
    await renderDetail(trip.id);
    expect(summaryValue('已使用金额')).toBe('¥0.00');
    expect(screen.getByText('该出差还没有关联发票，可在「发票」页选择后关联。')).toBeInTheDocument();
  });
});
