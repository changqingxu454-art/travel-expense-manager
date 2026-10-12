import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Trips from '../pages/Trips';
import TripDetail from '../pages/TripDetail';
import { closeDatabase, deleteDatabase } from '../services/db';
import { createInvoice, linkInvoiceToTrip } from '../services/invoiceService';
import { createTrip, listTrips } from '../services/tripService';
import type { InvoiceInput } from '../types';

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

/** 一张手工录入的发票；默认已确认的餐饮发票，可直接参与餐补统计。 */
function invoiceInput(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    amountCents: 1000,
    category: 'meal',
    status: 'confirmed',
    fileName: '',
    mimeType: '',
    size: 0,
    source: 'manual',
    ...overrides,
  };
}

function fillField(label: string, value: string): void {
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
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

/** 渲染列表页并等待首次 IndexedDB 读取完成，避免 act 警告。 */
async function renderTrips(): Promise<void> {
  render(<Trips />);
  await waitFor(() =>
    expect(screen.queryByText('正在读取本地数据…')).not.toBeInTheDocument(),
  );
}

/** 渲染详情页并等待首次 IndexedDB 读取完成。 */
async function renderDetail(tripId: string): Promise<void> {
  render(<TripDetail tripId={tripId} />);
  await waitFor(() =>
    expect(screen.queryByText('正在读取本地数据…')).not.toBeInTheDocument(),
  );
}

describe('出差列表页 UI', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('无数据时展示空状态', async () => {
    await renderTrips();
    expect(screen.getByText('还没有出差记录')).toBeInTheDocument();
  });

  it('新建表单默认每日 2 餐、每餐 25 元', async () => {
    await renderTrips();
    fireEvent.click(screen.getByRole('button', { name: '新建出差' }));

    expect(screen.getByLabelText('每日餐数')).toHaveValue(2);
    expect(screen.getByLabelText('每餐标准（元）')).toHaveValue('25');
  });

  it('名称留空时提示错误且不写入数据', async () => {
    await renderTrips();
    fireEvent.click(screen.getByRole('button', { name: '新建出差' }));
    fillField('开始日期', '2026-03-01');
    fillField('结束日期', '2026-03-03');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('请填写出差名称。')).toBeInTheDocument();
    expect(await listTrips()).toHaveLength(0);
  });

  it('结束日期早于开始日期时提示错误', async () => {
    await renderTrips();
    fireEvent.click(screen.getByRole('button', { name: '新建出差' }));
    fillField('出差名称', '测试出差');
    fillField('开始日期', '2026-03-05');
    fillField('结束日期', '2026-03-01');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(
      await screen.findByText('结束日期不能早于开始日期。'),
    ).toBeInTheDocument();
    expect(await listTrips()).toHaveLength(0);
  });

  it('创建成功后展示记录与餐补额度', async () => {
    await renderTrips();
    fireEvent.click(screen.getByRole('button', { name: '新建出差' }));
    fillField('出差名称', '北京出差');
    fillField('开始日期', '2026-03-01');
    fillField('结束日期', '2026-03-02');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('北京出差')).toBeInTheDocument();
    // 2 天 × 2 餐 × 25 元 = 100 元 = 10000 分
    expect(screen.getByText(/餐补 ¥100\.00/)).toBeInTheDocument();
    expect(await listTrips()).toHaveLength(1);
  });

  it('列表展示与详情页口径一致的已用餐补与剩余额度', async () => {
    const trip = await createTrip({
      name: '上海出差',
      startDate: '2026-03-01',
      endDate: '2026-03-02',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    // 已确认的餐饮发票：计入 1000 分
    const meal = await createInvoice(invoiceInput({ amountCents: 1000 }));
    await linkInvoiceToTrip(meal.id, trip.id);
    // 待核对的餐饮发票：即使已关联也不计入
    await createInvoice(
      invoiceInput({ amountCents: 9000, status: 'pending', tripId: trip.id }),
    );

    await renderTrips();

    expect(await screen.findByText('上海出差')).toBeInTheDocument();
    // 2 天 × 2 餐 × 25 元 = 100 元预算
    expect(screen.getByText(/餐补 ¥100\.00/)).toBeInTheDocument();
    expect(
      await screen.findByText('已用 ¥10.00 · 剩余 ¥90.00'),
    ).toBeInTheDocument();
  });

  it('删除前弹出二次确认，确认后记录消失', async () => {
    await createTrip({
      name: '待删除出差',
      startDate: '2026-03-01',
      endDate: '2026-03-01',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });

    await renderTrips();
    expect(screen.getByText('待删除出差')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('删除出差记录')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(screen.queryByText('待删除出差')).not.toBeInTheDocument();
    });
    expect(await listTrips()).toHaveLength(0);
  });

  it('取消删除时记录保留', async () => {
    await createTrip({
      name: '保留出差',
      startDate: '2026-03-01',
      endDate: '2026-03-01',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });

    await renderTrips();
    expect(screen.getByText('保留出差')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('保留出差')).toBeInTheDocument();
    expect(await listTrips()).toHaveLength(1);
  });
});

describe('出差详情页 UI', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('展示天数、餐标、总额度与真实的餐补使用情况', async () => {
    const trip = await createTrip({
      name: '详情出差',
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });

    await renderDetail(trip.id);

    expect(screen.getByText('详情出差')).toBeInTheDocument();
    expect(screen.getByText('3 天')).toBeInTheDocument();
    expect(screen.getByText('¥25.00')).toBeInTheDocument();

    // 3 天 × 2 餐 × 25 元 = 150 元；无发票时已用为 0，总额度与剩余额度相同。
    expect(summaryValue('餐补总额度')).toBe('¥150.00');
    expect(summaryValue('剩余额度')).toBe('¥150.00');
    expect(summaryValue('已使用金额')).toBe('¥0.00');
    expect(summaryValue('已使用比例')).toBe('0%');
    // 占位文案已删除，页面给出的是真实统计与明确口径
    expect(screen.queryByText('暂未接入发票统计')).not.toBeInTheDocument();
    expect(screen.getByText(/已使用金额只统计「已确认」、类别为「餐饮」/)).toBeInTheDocument();
  });

  it('详情页展示已确认餐饮发票带来的已用金额与剩余额度', async () => {
    const trip = await createTrip({
      name: '含发票出差',
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    const invoice = await createInvoice(invoiceInput({ amountCents: 4500 }));
    await linkInvoiceToTrip(invoice.id, trip.id);

    await renderDetail(trip.id);

    expect(summaryValue('已使用金额')).toBe('¥45.00');
    expect(summaryValue('剩余额度')).toBe('¥105.00');
    expect(summaryValue('已使用比例')).toBe('30%');
  });

  it('记录不存在时展示空状态', async () => {
    await renderDetail('missing-id');
    expect(screen.getByText('出差记录不存在')).toBeInTheDocument();
  });
});
