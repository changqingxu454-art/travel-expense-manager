import type { Trip, TripInput } from '../types';
import { AppError, toErrorInfo } from '../utils/errors';
import { validateTripInput } from '../features/trips/tripValidation';
import { STORE, countByIndex, withStore } from './db';

/**
 * 出差记录的数据访问层。
 *
 * 约定：
 * - 所有数据真实保存在 IndexedDB，不使用内存数组冒充持久化。
 * - 输入在写入前统一经过 {@link validateTripInput} 校验。
 * - 失败时抛出带稳定错误码的 {@link AppError}，供页面展示可读提示。
 */

/** 生成唯一 ID；优先使用 crypto.randomUUID，缺失时退化为时间戳 + 随机串。 */
function generateId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `trip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function wrapDbError(error: unknown, fallbackMessage: string): AppError {
  const info = toErrorInfo(error);
  return new AppError('DB_ERROR', `${fallbackMessage}：${info.message}`);
}

/** 获取全部出差记录，按开始日期倒序（新的在前）。 */
export async function listTrips(): Promise<Trip[]> {
  try {
    const trips = await withStore<Trip[]>(STORE.trips, 'readonly', (store) =>
      store.getAll(),
    );
    return trips.sort((a, b) => {
      if (a.startDate === b.startDate) {
        return b.createdAt.localeCompare(a.createdAt);
      }
      return b.startDate.localeCompare(a.startDate);
    });
  } catch (error) {
    throw wrapDbError(error, '读取出差记录失败');
  }
}

/** 根据 ID 获取单条记录；不存在时返回 null。 */
export async function getTrip(id: string): Promise<Trip | null> {
  if (id.trim() === '') {
    throw new AppError('INVALID_ID', '出差记录 ID 不能为空。');
  }
  try {
    const trip = await withStore<Trip | undefined>(STORE.trips, 'readonly', (store) =>
      store.get(id),
    );
    return trip ?? null;
  } catch (error) {
    throw wrapDbError(error, '读取出差记录失败');
  }
}

/**
 * 以 upsert 语义保存一条完整记录。
 *
 * 保留此函数是为了让调用方能在已知完整记录时直接落库；
 * 常规业务流程请使用 {@link createTrip} / {@link updateTrip}。
 */
export async function saveTrip(trip: Trip): Promise<void> {
  const validated = validateTripInput(trip);
  if (!validated.ok) {
    throw new AppError(validated.error.code, validated.error.message);
  }
  try {
    await withStore(STORE.trips, 'readwrite', (store) => store.put(trip));
  } catch (error) {
    throw wrapDbError(error, '保存出差记录失败');
  }
}

/** 创建出差记录：自动生成 ID、创建/更新时间与初始状态。 */
export async function createTrip(input: TripInput): Promise<Trip> {
  const validated = validateTripInput(input);
  if (!validated.ok) {
    throw new AppError(validated.error.code, validated.error.message);
  }
  const now = new Date().toISOString();
  const trip: Trip = {
    ...validated.value,
    id: generateId(),
    status: 'planned',
    createdAt: now,
    updatedAt: now,
  };
  await saveTrip(trip);
  return trip;
}

/** 更新出差记录：不存在时明确报错，并刷新 updatedAt。 */
export async function updateTrip(id: string, input: TripInput): Promise<Trip> {
  const validated = validateTripInput(input);
  if (!validated.ok) {
    throw new AppError(validated.error.code, validated.error.message);
  }
  const existing = await getTrip(id);
  if (!existing) {
    throw new AppError('NOT_FOUND', '要更新的出差记录不存在，可能已被删除。');
  }
  const trip: Trip = {
    ...existing,
    ...validated.value,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await saveTrip(trip);
  return trip;
}

/** 统计某条出差记录已关联的发票数量（读取真实数据）。 */
export async function countRelatedInvoices(tripId: string): Promise<number> {
  try {
    return await countByIndex(STORE.invoices, 'by_tripId', tripId);
  } catch (error) {
    throw wrapDbError(error, '统计关联发票失败');
  }
}

/**
 * 删除出差记录。
 *
 * 引用完整性策略：**阻止删除仍有关联发票的记录**，
 * 而不是静默留下失效的 tripId 关联或擅自解除关联。
 */
export async function removeTrip(id: string): Promise<void> {
  if (id.trim() === '') {
    throw new AppError('INVALID_ID', '出差记录 ID 不能为空。');
  }
  const existing = await getTrip(id);
  if (!existing) {
    throw new AppError('NOT_FOUND', '要删除的出差记录不存在，可能已被删除。');
  }
  const related = await countRelatedInvoices(id);
  if (related > 0) {
    throw new AppError(
      'TRIP_HAS_INVOICES',
      `该出差已关联 ${related} 张发票，请先解除关联后再删除。`,
    );
  }
  try {
    await withStore(STORE.trips, 'readwrite', (store) => store.delete(id));
  } catch (error) {
    throw wrapDbError(error, '删除出差记录失败');
  }
}
