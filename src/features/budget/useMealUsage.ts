import { useCallback, useEffect, useRef, useState } from 'react';
import type { MealUsageSummary } from '../../types';
import { toErrorInfo } from '../../utils/errors';
import { getMealUsageSummary } from '../../services/budgetService';

export interface MealUsageState {
  /** 统计数据；读取中或失败时为 null。 */
  summary: MealUsageSummary | null;
  loading: boolean;
  /** 读取失败时的可读提示；成功时为 null。 */
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * 读取单次出差的餐补统计。
 *
 * 与 `useTrips` / `useInvoices` 保持一致：数据始终来自 IndexedDB，
 * 不使用页面初次加载时的旧缓存；查询失败时明确置为 error 而不是显示 0 元。
 */
export function useMealUsage(tripId: string): MealUsageState {
  const [summary, setSummary] = useState<MealUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMealUsageSummary(tripId);
      if (!mountedRef.current) {
        return;
      }
      setSummary(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setSummary(null);
      setError(toErrorInfo(err).message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [tripId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { summary, loading, error, reload };
}
