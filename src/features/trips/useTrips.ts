import { useCallback, useEffect, useRef, useState } from 'react';
import type { Trip } from '../../types';
import { toErrorInfo } from '../../utils/errors';
import { listTrips } from '../../services/tripService';

export interface TripsState {
  trips: Trip[];
  loading: boolean;
  /** 读取失败时的可读提示；成功时为 null。 */
  error: string | null;
  reload: () => Promise<void>;
}

/** 从 IndexedDB 读取出差记录列表，并提供重新读取能力（保存后调用以刷新页面）。 */
export function useTrips(): TripsState {
  const [trips, setTrips] = useState<Trip[]>([]);
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
      const data = await listTrips();
      if (!mountedRef.current) {
        return;
      }
      setTrips(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setTrips([]);
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

  return { trips, loading, error, reload };
}
