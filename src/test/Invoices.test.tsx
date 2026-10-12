import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// 让 PDF.js 在 jsdom 中使用主线程 worker，从而走真实的解析链路。
import 'pdfjs-dist/build/pdf.worker.mjs';
import Invoices from '../pages/Invoices';
import { closeDatabase, deleteDatabase } from '../services/db';
import {
  createInvoice,
  linkInvoiceToTrip,
  listInvoices,
} from '../services/invoiceService';
import { createTrip } from '../services/tripService';
import { buildCjkInvoicePdf, buildNotPdf } from './pdfFixture';

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

async function renderInvoices(): Promise<void> {
  render(<Invoices />);
  await waitFor(() =>
    expect(screen.queryByText('正在读取本地数据…')).not.toBeInTheDocument(),
  );
}

/** 上传文件：jsdom 中需要显式定义只读的 files 属性。 */
function uploadFile(file: File): void {
  const input = screen.getByLabelText('选择 PDF 发票');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

function invoicePdfFile(name = 'invoice.pdf'): File {
  const bytes = buildCjkInvoicePdf([
    '增值税电子普通发票',
    '发票号码 12345678',
    '开票日期 2026年03月15日',
    '销售方名称 北京某某酒店管理有限公司',
    '价税合计(小写)¥106.00',
  ]);
  return new File([bytes], name, { type: 'application/pdf' });
}

function setField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function selectOption(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** 读取统计卡的主数值（已确认金额合计）。 */
function confirmedTotal(): string {
  const card = screen.getByText('已确认金额合计').closest('.stat-card');
  return card?.querySelector('.stat-card__value')?.textContent ?? '';
}

/** 读取统计卡下方某一项的数值（「标签 → 值」形式）。 */
function breakdownValue(label: string): string {
  const labelEl = screen.getByText(label);
  const row = labelEl.closest('.detail-list__row');
  if (!row) {
    throw new Error(`未找到统计项：${label}`);
  }
  return row.querySelector('dd')?.textContent ?? '';
}

const MEAL_LINKED_LABEL = '其中：已关联出差的餐饮发票（可计入对应出差餐补）';
const PENDING_LABEL = '待核对发票金额（不计入合计）';

/** 读取「发票分类汇总」卡中某一分类的金额（标签形如「餐饮（2 张）」）。 */
function categoryAmount(categoryLabel: string): string {
  const labelEl = screen.getByText(new RegExp(`^${categoryLabel}（`));
  const row = labelEl.closest('.detail-list__row');
  if (!row) {
    throw new Error(`未找到分类汇总项：${categoryLabel}`);
  }
  return row.querySelector('dd')?.textContent ?? '';
}

describe('发票管理页 UI', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('展示上传入口与空列表状态', async () => {
    await renderInvoices();
    expect(screen.getByLabelText('选择 PDF 发票')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '手动新增发票' }),
    ).toBeInTheDocument();
    expect(screen.getByText('还没有发票')).toBeInTheDocument();
  });

  it('上传 PDF 后进入核对表单并展示识别结果', async () => {
    await renderInvoices();
    uploadFile(invoicePdfFile());

    expect(await screen.findByText('核对识别结果')).toBeInTheDocument();
    expect(screen.getByLabelText(/发票号码/)).toHaveValue('12345678');
    expect(screen.getByLabelText(/开票日期/)).toHaveValue('2026-03-15');
    expect(screen.getByLabelText(/销售方名称/)).toHaveValue(
      '北京某某酒店管理有限公司',
    );
    expect(screen.getByLabelText(/价税合计（元）/)).toHaveValue('106');

    // 未保存前列表仍为空，不产生任何正式记录
    expect(await listInvoices()).toHaveLength(0);
  });

  it('确认状态后保存，只有已确认的发票计入金额合计', async () => {
    await renderInvoices();
    uploadFile(invoicePdfFile());
    await screen.findByText('核对识别结果');

    selectOption('识别状态', 'confirmed');
    selectOption('发票类别', 'accommodation');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const title = await screen.findByText('12345678');
    const item = title.closest('.invoice-item');
    expect(item).not.toBeNull();
    // 状态徽标位于该条目内（页面上还有同名的筛选按钮）
    expect(within(item as HTMLElement).getByText('已确认')).toBeInTheDocument();
    expect(within(item as HTMLElement).getByText('¥106.00')).toBeInTheDocument();

    const saved = await listInvoices();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe('confirmed');
    expect(saved[0]?.amountCents).toBe(10600);
    expect(saved[0]?.category).toBe('accommodation');
    expect(saved[0]?.fileId).toBeTruthy();
  });

  it('保持「待核对」时不填金额也能保存，但金额保持 undefined', async () => {
    await renderInvoices();
    fireEvent.click(screen.getByRole('button', { name: '手动新增发票' }));
    await screen.findByText('手动录入发票');

    setField('发票号码', '87654321');
    selectOption('发票类别', 'meal');
    fireEvent.click(screen.getByRole('button', { name: '保存发票' }));

    await waitFor(async () => {
      expect(await listInvoices()).toHaveLength(1);
    });
    const saved = await listInvoices();
    expect(saved[0]?.status).toBe('pending');
    expect(saved[0]?.amountCents).toBeUndefined();
    expect(saved[0]?.amountCents).not.toBe(0);
    expect(await screen.findByText('金额未填写（不计入合计）')).toBeInTheDocument();
  });

  it('标记为「已确认」但未填金额时拒绝保存并提示', async () => {
    await renderInvoices();
    fireEvent.click(screen.getByRole('button', { name: '手动新增发票' }));
    await screen.findByText('手动录入发票');

    selectOption('识别状态', 'confirmed');
    fireEvent.click(screen.getByRole('button', { name: '保存发票' }));

    expect(
      await screen.findByText(/标记为「已确认」前必须填写金额/),
    ).toBeInTheDocument();
    expect(await listInvoices()).toHaveLength(0);
  });

  it('上传非 PDF 文件时明确报错并提供手动录入入口', async () => {
    await renderInvoices();
    const bad = new File([buildNotPdf()], 'note.txt', { type: 'text/plain' });
    uploadFile(bad);

    expect(await screen.findByText(/无法解析该 PDF/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '手动录入' }));
    expect(await screen.findByText('手动录入发票')).toBeInTheDocument();
  });

  it('扫描版 PDF 提示暂不支持自动识别，并提供手动录入', async () => {
    await renderInvoices();
    // 空内容流的 PDF：可打开但没有可提取文本
    const scanLike = new File([buildCjkInvoicePdf([])], 'scan.pdf', {
      type: 'application/pdf',
    });
    uploadFile(scanLike);

    expect(
      await screen.findByText(/暂不支持自动识别，请手动录入/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '手动录入' }));
    const form = await screen.findByText('手动录入发票');
    expect(form).toBeInTheDocument();
    // 附件被保留，会与手工录入的字段一起保存
    expect(screen.getByText(/scan\.pdf/)).toBeInTheDocument();
  });

  it('编辑已保存的发票并持久化修改', async () => {
    await createInvoice({
      invoiceNumber: '11112222',
      amountCents: 5000,
      category: 'meal',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });

    await renderInvoices();
    expect(await screen.findByText('11112222')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByText('编辑发票');
    setField('销售方名称', '某某餐饮有限公司');
    setField('价税合计（元）', '88.80');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(async () => {
      const all = await listInvoices();
      expect(all[0]?.sellerName).toBe('某某餐饮有限公司');
      expect(all[0]?.amountCents).toBe(8880);
    });
  });

  it('删除发票需要二次确认', async () => {
    await createInvoice({
      invoiceNumber: '33334444',
      category: 'other',
      status: 'pending',
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      size: 1,
      source: 'pdf',
    });

    await renderInvoices();
    expect(await screen.findByText('33334444')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(screen.queryByText('33334444')).not.toBeInTheDocument();
    });
    expect(await listInvoices()).toHaveLength(0);
  });

  it('关联出差并解除关联', async () => {
    const trip = await createTrip({
      name: '北京出差',
      startDate: '2026-03-01',
      endDate: '2026-03-02',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    await createInvoice({
      invoiceNumber: '55556666',
      amountCents: 1000,
      category: 'transport',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });

    await renderInvoices();
    expect(await screen.findByText('55556666')).toBeInTheDocument();
    expect(screen.getByText('未关联出差')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关联出差' }));
    await waitFor(async () => {
      const all = await listInvoices();
      expect(all[0]?.tripId).toBe(trip.id);
    });
    expect(await screen.findByText('已关联出差：北京出差')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '解除关联' }));
    await waitFor(async () => {
      const all = await listInvoices();
      expect(all[0]?.tripId).toBeUndefined();
    });
    expect(await screen.findByText('未关联出差')).toBeInTheDocument();
  });

  it('按类别筛选发票', async () => {
    await createInvoice({
      invoiceNumber: '77778888',
      amountCents: 100,
      category: 'meal',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await createInvoice({
      invoiceNumber: '99990000',
      amountCents: 200,
      category: 'transport',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });

    await renderInvoices();
    expect(await screen.findByText('77778888')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '餐饮' }));
    await waitFor(() => {
      expect(screen.queryByText('99990000')).not.toBeInTheDocument();
    });
    expect(screen.getByText('77778888')).toBeInTheDocument();
  });

  it('提示疑似重复发票且不自动处理', async () => {
    await createInvoice({
      invoiceNumber: '12121212',
      amountCents: 500,
      category: 'meal',
      status: 'confirmed',
      fileName: 'first.pdf',
      mimeType: 'application/pdf',
      size: 1,
      source: 'pdf',
    });

    await renderInvoices();
    fireEvent.click(screen.getByRole('button', { name: '手动新增发票' }));
    await screen.findByText('手动录入发票');

    setField('发票号码', '12121212');
    setField('价税合计（元）', '5.00');
    selectOption('识别状态', 'confirmed');
    fireEvent.click(screen.getByRole('button', { name: '保存发票' }));

    expect(await screen.findByText(/检测到 1 条疑似重复发票/)).toBeInTheDocument();
    expect(await listInvoices()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '仍然保存' }));
    await waitFor(async () => {
      expect(await listInvoices()).toHaveLength(2);
    });
  });

  it('统计口径明确区分已确认合计、可计入餐补的餐饮发票与待核对金额', async () => {
    const trip = await createTrip({
      name: '北京出差',
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    const manual = {
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    } as const;

    // 1) 已确认的餐饮发票 + 已关联出差 → 可计入餐补
    const linkedMeal = await createInvoice({
      ...manual,
      amountCents: 3000,
      category: 'meal',
      status: 'confirmed',
    });
    await linkInvoiceToTrip(linkedMeal.id, trip.id);

    // 2) 已确认的住宿发票 → 计入合计但不计入餐补
    await createInvoice({
      ...manual,
      amountCents: 10600,
      category: 'accommodation',
      status: 'confirmed',
    });

    // 3) 已确认但未关联出差的餐饮发票 → 不计入任何出差的餐补
    await createInvoice({
      ...manual,
      amountCents: 2000,
      category: 'meal',
      status: 'confirmed',
    });

    // 4) 待核对的餐饮发票 → 不计入合计
    await createInvoice({
      ...manual,
      amountCents: 5000,
      category: 'meal',
      status: 'pending',
      tripId: trip.id,
    });

    await renderInvoices();

    // 3000 + 10600 + 2000 = 15600 分
    expect(confirmedTotal()).toBe('¥156.00');
    expect(breakdownValue(MEAL_LINKED_LABEL)).toBe('¥30.00');
    expect(breakdownValue(PENDING_LABEL)).toBe('¥50.00');
  });

  it('确认、改金额、解除关联与删除后统计即时更新', async () => {
    const trip = await createTrip({
      name: '北京出差',
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });

    await renderInvoices();
    expect(confirmedTotal()).toBe('¥0.00');

    // 手动录入：餐饮 + 已确认 + 关联出差
    fireEvent.click(screen.getByRole('button', { name: '手动新增发票' }));
    await screen.findByText('手动录入发票');
    setField('发票号码', '50505050');
    setField('价税合计（元）', '50');
    selectOption('发票类别', 'meal');
    selectOption('识别状态', 'confirmed');
    selectOption('关联出差', trip.id);
    fireEvent.click(screen.getByRole('button', { name: '保存发票' }));

    await waitFor(() => expect(confirmedTotal()).toBe('¥50.00'));
    expect(breakdownValue(MEAL_LINKED_LABEL)).toBe('¥50.00');

    // 编辑金额 → 两处统计同步变化
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByText('编辑发票');
    setField('价税合计（元）', '80');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(confirmedTotal()).toBe('¥80.00'));
    expect(breakdownValue(MEAL_LINKED_LABEL)).toBe('¥80.00');

    // 解除关联 → 仍是已确认发票，但不再计入任何出差的餐补
    fireEvent.click(screen.getByRole('button', { name: '解除关联' }));
    await waitFor(() => expect(screen.getByText('未关联出差')).toBeInTheDocument());
    expect(confirmedTotal()).toBe('¥80.00');
    expect(breakdownValue(MEAL_LINKED_LABEL)).toBe('¥0.00');

    // 删除 → 统计归零
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(confirmedTotal()).toBe('¥0.00'));
    expect(breakdownValue(MEAL_LINKED_LABEL)).toBe('¥0.00');
    expect(await listInvoices()).toHaveLength(0);
  });

  it('读取失败时展示错误与重试入口', async () => {
    await resetDatabase();
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
    });
    try {
      render(<Invoices />);
      expect(await screen.findByText(/读取发票失败/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
      });
    }
  });

  it('分类汇总按类别拆分金额与数量，且各分类合计等于已确认合计', async () => {
    await createInvoice({
      invoiceNumber: '10000001',
      amountCents: 3000,
      category: 'meal',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await createInvoice({
      invoiceNumber: '10000002',
      amountCents: 10600,
      category: 'accommodation',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await createInvoice({
      invoiceNumber: '10000003',
      amountCents: 4200,
      category: 'transport',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await createInvoice({
      invoiceNumber: '10000004',
      amountCents: 500,
      category: 'other',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });

    await renderInvoices();

    // 已确认合计 = 3000 + 10600 + 4200 + 500 = 18300 分
    expect(confirmedTotal()).toBe('¥183.00');
    expect(categoryAmount('餐饮')).toBe('¥30.00');
    expect(categoryAmount('住宿')).toBe('¥106.00');
    expect(categoryAmount('交通')).toBe('¥42.00');
    expect(categoryAmount('其他')).toBe('¥5.00');
  });

  it('分类汇总区分待核对与识别失败，且不把待核对计入金额', async () => {
    await createInvoice({
      invoiceNumber: '20000001',
      amountCents: 3000,
      category: 'meal',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await createInvoice({
      invoiceNumber: '20000002',
      amountCents: 900,
      category: 'meal',
      status: 'pending',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await createInvoice({
      invoiceNumber: '20000003',
      category: 'meal',
      status: 'failed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });

    await renderInvoices();

    // 只有已确认的 3000 分计入金额
    expect(confirmedTotal()).toBe('¥30.00');
    expect(categoryAmount('餐饮')).toBe('¥30.00');

    const summary = screen.getByText('发票分类汇总').closest('.stat-card');
    expect(summary).not.toBeNull();
    // 待核对 1 张、识别失败 1 张
    expect(within(summary as HTMLElement).getByText('待核对发票')).toBeInTheDocument();
    expect(within(summary as HTMLElement).getByText('识别失败发票')).toBeInTheDocument();
  });

  it('解除出差关联不影响分类金额，但影响餐补口径', async () => {
    const trip = await createTrip({
      name: '北京出差',
      startDate: '2026-03-01',
      endDate: '2026-03-03',
      mealsPerDay: 2,
      mealStandardCents: 2500,
    });
    const invoice = await createInvoice({
      invoiceNumber: '30000001',
      amountCents: 5000,
      category: 'meal',
      status: 'confirmed',
      fileName: '',
      mimeType: '',
      size: 0,
      source: 'manual',
    });
    await linkInvoiceToTrip(invoice.id, trip.id);

    await renderInvoices();

    expect(breakdownValue(MEAL_LINKED_LABEL)).toBe('¥50.00');
    expect(categoryAmount('餐饮')).toBe('¥50.00');

    // 解除关联后：分类金额不变，但「可计入餐补」归零
    fireEvent.click(screen.getByRole('button', { name: '解除关联' }));
    await waitFor(() => expect(screen.getByText('未关联出差')).toBeInTheDocument());
    expect(categoryAmount('餐饮')).toBe('¥50.00');
    expect(breakdownValue(MEAL_LINKED_LABEL)).toBe('¥0.00');
  });

  it('编辑金额、类别、状态、删除发票后分类汇总及时更新', async () => {
    await renderInvoices();

    // 手动录入一张已确认餐饮发票
    fireEvent.click(screen.getByRole('button', { name: '手动新增发票' }));
    await screen.findByText('手动录入发票');
    setField('发票号码', '40000001');
    setField('价税合计（元）', '40');
    selectOption('发票类别', 'meal');
    selectOption('识别状态', 'confirmed');
    fireEvent.click(screen.getByRole('button', { name: '保存发票' }));

    await waitFor(() => expect(categoryAmount('餐饮')).toBe('¥40.00'));

    // 编辑类别为住宿 → 餐饮归零、住宿增加
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await screen.findByText('编辑发票');
    selectOption('发票类别', 'accommodation');
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(categoryAmount('住宿')).toBe('¥40.00'));
    expect(categoryAmount('餐饮')).toBe('¥0.00');

    // 删除后住宿归零
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(categoryAmount('住宿')).toBe('¥0.00'));
    expect(await listInvoices()).toHaveLength(0);
  });

});
