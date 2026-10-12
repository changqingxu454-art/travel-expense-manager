import { useCallback, useEffect, useRef, useState } from 'react';
import type { MealUsageSummary, Trip } from '../../types';
import { toErrorInfo } from '../../utils/errors';
import { listMealUsageSummaries } from '../../services/budgetService';

export interface MealUsageListState {
  /** 出差 id → 餐补统计；读取中或失败时为空 Map。 */
  usageByTrip: Map<string, MealUsageSummary>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** 出差列表中与餐补统计相关的字段指纹，用于在出差变化时重新查询。 */
function buildTripsKey(trips: readonly Trip[]): string {
  return trips
    .map((trip) =>
      [
        trip.id,
        trip.startDate,
        trip.endDate,
        trip.mealsPerDay,
        trip.mealStandardCents,
      ].join(':'),
    )
    .join('|');
}

/**
 * 批量读取多条出差的餐补统计（列表页 / 首页使用）。
 *
 * 底层只发起一次发票查询，避免 N+1；出差日期、餐数或餐标变化时会自动重新查询，
 * 从而与 IndexedDB 中的真实数据保持一致。
 */
export function useMealUsageList(trips: readonly Trip[]): MealUsageListState {
  const [usageByTrip, setUsageByTrip] = useState<Map<string, MealUsageSummary>>(
    new Map(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const tripsRef = useRef(trips);
  tripsRef.current = trips;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listMealUsageSummaries(tripsRef.current);
      if (!mountedRef.current) {
        return;
      }
      setUsageByTrip(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setUsageByTrip(new Map());
      setError(toErrorInfo(err).message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const tripsKey = buildTripsKey(trips);

  useEffect(() => {
    void reload();
    // tripsKey 变化即重新查询；trips 本身通过 ref 读取，避免数组字面量导致重复请求。
  }, [reload, tripsKey]);

  return { usageByTrip, loading, error, reload };
}
