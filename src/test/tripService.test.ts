import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TripInput } from '../types';
import { closeDatabase, deleteDatabase, openDatabase, STORE } from '../services/db';
import {
  countRelatedInvoices,
  createTrip,
  getTrip,
  listTrips,
  removeTrip,
  saveTrip,
  updateTrip,
} from '../services/tripService';

const baseInput: TripInput = {
  name: '北京出差',
  startDate: '2026-03-01',
  endDate: '2026-03-03',
  mealsPerDay: 2,
  mealStandardCents: 2500,
};

async function resetDatabase(): Promise<void> {
  await closeDatabase();
  await deleteDatabase();
}

describe('tripService（IndexedDB）', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it('创建记录后可以查询到', async () => {
    const created = await createTrip(baseInput);
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('planned');
    expect(created.createdAt).toBeTruthy();

    const all = await listTrips();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('北京出差');
  });

  it('根据 ID 获取记录', async () => {
    const created = await createTrip(baseInput);
    const found = await getTrip(created.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.mealStandardCents).toBe(2500);
  });

  it('查询不存在的 ID 返回 null', async () => {
    expect(await getTrip('missing-id')).toBeNull();
  });

  it('更新记录后数据正确变化且刷新 updatedAt', async () => {
    const created = await createTrip(baseInput);

    // 确保时间戳可观察地变化。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await updateTrip(created.id, {
      ...baseInput,
      name: '上海出差',
      endDate: '2026-03-05',
      mealsPerDay: 3,
    });

    const found = await getTrip(created.id);
    expect(found?.name).toBe('上海出差');
    expect(found?.endDate).toBe('2026-03-05');
    expect(found?.mealsPerDay).toBe(3);
    expect(found?.createdAt).toBe(created.createdAt);
    expect(found?.updatedAt).not.toBe(created.updatedAt);
    expect(updated.updatedAt).toBe(found?.updatedAt);
  });

  it('删除记录后数据不存在', async () => {
    const created = await createTrip(baseInput);
    await removeTrip(created.id);
    expect(await getTrip(created.id)).toBeNull();
    expect(await listTrips()).toHaveLength(0);
  });

  it('删除不存在的记录时明确报错', async () => {
    await expect(removeTrip('missing-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('更新不存在的记录时明确报错', async () => {
    await expect(updateTrip('missing-id', baseInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('重复 ID 使用 put 覆盖语义，不会产生重复记录', async () => {
    const created = await createTrip(baseInput);
    await saveTrip({ ...created, name: '覆盖后的名称' });
    const all = await listTrips();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe('覆盖后的名称');
  });

  it('创建与更新时拒绝无效数据', async () => {
    await expect(
      createTrip({ ...baseInput, name: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME' });

    await expect(
      createTrip({ ...baseInput, endDate: '2026-02-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE' });

    await expect(
      createTrip({ ...baseInput, mealsPerDay: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_MEALS' });

    await expect(
      createTrip({ ...baseInput, mealStandardCents: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_MEAL_STANDARD' });

    expect(await listTrips()).toHaveLength(0);
  });

  it('存在关联发票时阻止删除并给出提示', async () => {
    const created = await createTrip(baseInput);
    await putLinkedInvoice(created.id);

    expect(await countRelatedInvoices(created.id)).toBe(1);
    await expect(removeTrip(created.id)).rejects.toMatchObject({
      code: 'TRIP_HAS_INVOICES',
    });
    // 记录未被删除，关联关系未被静默破坏。
    expect(await getTrip(created.id)).not.toBeNull();
  });

  it('数据库异常时返回可读错误', async () => {
    const original = globalThis.indexedDB;
    // 模拟浏览器隐私模式等场景下的 IndexedDB 不可用。
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
    });
    try {
      await expect(listTrips()).rejects.toMatchObject({ code: 'DB_ERROR' });
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
      });
    }
  });

  it('各测试之间相互独立（数据库已清空）', async () => {
    expect(await listTrips()).toHaveLength(0);
  });
});

/** 直接写入一条发票记录，用于验证「阻止删除」的引用完整性策略。 */
async function putLinkedInvoice(tripId: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE.invoices, 'readwrite');
    tx.objectStore(STORE.invoices).put({
      id: `inv-${tripId}`,
      tripId,
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      source: 'pdf',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
