import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Dashboard from '../pages/Dashboard';
import { closeDatabase, deleteDatabase } from '../services/db';
import { createInvoice, linkInvoiceToTrip } from '../services/invoiceService';
import { createTrip } from '../services/tripService';

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
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

async function renderDashboard(): Promise<void> {
  render(<Dashboard />);
  await waitFor(() =>
    expect(screen.queryByText('正在读取本地数据…')).not.toBeInTheDocument(),
  );
  // 财务总览是异步加载的，等待「出差记录」卡片离开占位符（"…"）再断言。
  await waitFor(() =>
    expect(cardValue('出差记录')).not.toBe('…'),
  );
}

/** 读取统计卡主数值（按标签定位）。 */
function cardValue(label: string): string {
  const labelEl = screen.getByText(label);
  const card = labelEl.closest('.stat-card');
  if (!card) {
    throw new Error(`未找到统计卡：${label}`);
  }
  return card.querySelector('.stat-card__value')?.textContent ?? '';
}

describe('首页财务总览', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('没有出差和发票时展示空状态与零值', async () => {
    await renderDashboard();

    expect(screen.getByText('还没有出差记录')).toBeInTheDocument();
    expect(cardValue('出差记录')).toBe('0');
    expect(cardValue('餐补预算总额')).toBe('¥0.00');
    expect(cardValue('餐补已使用')).toBe('¥0.00');
    expect(cardValue('餐补剩余额度')).toBe('¥0.00');
    expect(cardValue('已确认发票合计')).toBe('¥0.00');
    expect(cardValue('待核对发票')).toBe('0');
  });

  it('汇总多条出差的预算与餐补已使用', async () => {
    const trip = await createTrip(tripInput());
    await createTrip(tripInput('上海出差'));

    const meal = await createInvoice({
      amountCents: 3200,
      category: 'meal',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await linkInvoiceToTrip(meal.id, trip.id);

    await renderDashboard();

    expect(cardValue('出差记录')).toBe('2');
    // 两条出差各 15000 分
    expect(cardValue('餐补预算总额')).toBe('¥300.00');
    expect(cardValue('餐补已使用')).toBe('¥32.00');
    expect(cardValue('餐补剩余额度')).toBe('¥268.00');
  });

  it('已确认发票合计含全部类别，餐补只统计餐饮', async () => {
    const trip = await createTrip(tripInput());

    const meal = await createInvoice({
      amountCents: 2000,
      category: 'meal',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await linkInvoiceToTrip(meal.id, trip.id);

    await createInvoice({
      amountCents: 10600,
      category: 'accommodation',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await createInvoice({
      amountCents: 5000,
      category: 'meal',
      status: 'pending',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });

    await renderDashboard();

    // 已确认合计 = 2000(餐饮) + 10600(住宿) = 12600，不含待核对
    expect(cardValue('已确认发票合计')).toBe('¥126.00');
    // 餐补只统计关联到出差的餐饮发票
    expect(cardValue('餐补已使用')).toBe('¥20.00');
    expect(cardValue('待核对发票')).toBe('1');
  });

  it('查询失败时展示错误而不是伪装成零金额', async () => {
    await resetDatabase();
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
    });
    try {
      render(<Dashboard />);
      // 出差记录读取失败会先展示错误；财务总览/餐补也各自报错
      expect(
        await screen.findByText(/读取出差记录失败/),
      ).toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
      });
    }
  });
});
