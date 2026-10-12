import { useCallback, useEffect, useRef, useState } from 'react';
import type { Invoice } from '../../types';
import { toErrorInfo } from '../../utils/errors';
import { listInvoices, type InvoiceQuery } from '../../services/invoiceService';

export interface InvoicesState {
  invoices: Invoice[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * 读取发票列表。
 *
 * `filterKey` 由调用方传入（通常是序列化后的筛选条件），用于在筛选变化时重新查询；
 * 查询始终走 IndexedDB，不使用内存缓存冒充数据源。
 */
export function useInvoices(query: InvoiceQuery, filterKey: string): InvoicesState {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listInvoices(queryRef.current);
      if (!mountedRef.current) {
        return;
      }
      setInvoices(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setInvoices([]);
      setError(toErrorInfo(err).message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
    // filterKey 变化即重新查询；query 本身通过 ref 读取，避免对象字面量导致重复请求。
  }, [reload, filterKey]);

  return { invoices, loading, error, reload };
}
