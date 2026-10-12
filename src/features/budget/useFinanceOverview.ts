import { useCallback, useEffect, useRef, useState } from 'react';
import type { FinanceOverview } from '../../services/budgetService';
import { getFinanceOverview } from '../../services/budgetService';
import { toErrorInfo } from '../../utils/errors';

export interface FinanceOverviewState {
  /** 财务总览；读取中或失败时为 null。 */
  overview: FinanceOverview | null;
  loading: boolean;
  /** 读取失败时的可读提示；成功时为 null。 */
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * 读取首页财务总览。
 *
 * 与其它数据 hook 保持一致：数据始终来自 IndexedDB（经 {@link getFinanceOverview}），
 * 不使用内存缓存冒充数据源；查询失败时明确置为 error，而不是把金额显示成 0。
 */
export function useFinanceOverview(): FinanceOverviewState {
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
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
      const data = await getFinanceOverview();
      if (!mountedRef.current) {
        return;
      }
      setOverview(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setOverview(null);
      setError(toErrorInfo(err).message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { overview, loading, error, reload };
}
