/**
 * IndexedDB 初始化与连接管理。
 *
 * 所有业务数据与 PDF 二进制都保存在浏览器本地，不上传任何服务器。
 */

export const DB_NAME = 'travel-expense-manager';

/**
 * 数据库版本。
 *
 * 版本 2 的变更仅为在既有 `invoices` 仓库上**新增索引**（by_category / by_status / by_fileId），
 * 用于按类别、识别状态与文件 id 查询。没有新增或删除对象仓库、没有改动主键，
 * 因此升级不会丢失任何既有数据：IndexedDB 会在升级事务中自动为已有记录建立新索引。
 */
export const DB_VERSION = 2;

/** 对象仓库名称常量，避免各模块手写字符串。 */
export const STORE = {
  trips: 'trips',
  invoices: 'invoices',
  invoiceFiles: 'invoiceFiles',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 幂等地确保索引存在；既支持全新安装，也支持从旧版本升级。 */
function ensureIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string,
): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath, { unique: false });
  }
}

function createSchema(db: IDBDatabase, transaction: IDBTransaction | null): void {
  let trips: IDBObjectStore;
  if (!db.objectStoreNames.contains(STORE.trips)) {
    trips = db.createObjectStore(STORE.trips, { keyPath: 'id' });
  } else {
    trips = requireStore(transaction, STORE.trips);
  }
  ensureIndex(trips, 'by_startDate', 'startDate');

  let invoices: IDBObjectStore;
  if (!db.objectStoreNames.contains(STORE.invoices)) {
    invoices = db.createObjectStore(STORE.invoices, { keyPath: 'id' });
  } else {
    invoices = requireStore(transaction, STORE.invoices);
  }
  ensureIndex(invoices, 'by_tripId', 'tripId');
  ensureIndex(invoices, 'by_issuedAt', 'issuedAt');
  // 版本 2 新增：按类别、识别状态、关联文件查询。
  ensureIndex(invoices, 'by_category', 'category');
  ensureIndex(invoices, 'by_status', 'status');
  ensureIndex(invoices, 'by_fileId', 'fileId');

  // 发票原始文件单独存放，避免列表查询时把大 Blob 读进内存。
  if (!db.objectStoreNames.contains(STORE.invoiceFiles)) {
    db.createObjectStore(STORE.invoiceFiles, { keyPath: 'id' });
  }
}

/** 在升级事务中取出已存在的对象仓库，用于补建索引。 */
function requireStore(
  transaction: IDBTransaction | null,
  name: StoreName,
): IDBObjectStore {
  if (!transaction) {
    throw new Error(`升级事务不可用，无法为 ${name} 建立索引。`);
  }
  return transaction.objectStore(name);
}

/** 打开（首次访问时创建）数据库连接；同一会话内复用。 */
export function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new Error('当前环境不支持 IndexedDB，无法在本地保存数据。'),
    );
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      createSchema(request.result, request.transaction);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('无法打开本地数据库。'));
    };
    request.onblocked = () => {
      reject(new Error('数据库升级被其它标签页阻塞，请关闭其它页面后重试。'));
    };
  });

  return dbPromise;
}

/** 关闭当前连接并重置缓存（便于测试与「清空数据」）。 */
export async function closeDatabase(): Promise<void> {
  if (!dbPromise) {
    return;
  }
  const db = await dbPromise.catch(() => null);
  db?.close();
  dbPromise = null;
}

/** 删除整个本地数据库，用于用户主动清空全部数据。 */
export async function deleteDatabase(): Promise<void> {
  await closeDatabase();
  if (typeof indexedDB === 'undefined') {
    return;
  }
  await requestToPromise(indexedDB.deleteDatabase(DB_NAME));
}

/** 在只读/读写事务中执行一次操作。 */
export async function withStore<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.onabort = () => reject(tx.error ?? new Error('事务被中止。'));
    tx.onerror = () => reject(tx.error ?? new Error('数据库事务失败。'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('数据库操作失败。'));
  });
}

/**
 * 在跨越多个对象仓库的**单个原子事务**中执行写入。
 *
 * `run` 中必须**同步**发起所有请求（不要 await），否则事务会在等待期间自动提交。
 * 任一请求失败都会让整个事务中止，从而保证多个仓库要么全部写入、要么全部不写入
 * ——这是「发票元数据」与「PDF 文件」保持一致性的基础。
 */
export async function withTransaction(
  storeNames: StoreName[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => void,
): Promise<void> {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('数据库事务失败。'));
    tx.onabort = () => reject(tx.error ?? new Error('数据库事务被中止。'));
    try {
      run(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // 事务可能已因错误中止，此处忽略。
      }
      reject(error);
    }
  });
}

/** 通过索引读取全部匹配记录。 */
export async function getAllByIndex<T>(
  storeName: StoreName,
  indexName: string,
  query: IDBValidKey,
): Promise<T[]> {
  const db = await openDatabase();
  return new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).index(indexName).getAll(query);
    tx.onerror = () => reject(tx.error ?? new Error('数据库查询失败。'));
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error('数据库查询失败。'));
  });
}

/**
 * 通过索引统计记录数。
 *
 * 用于执行「删除出差前检查是否已关联发票」这类引用完整性校验，
 * 直接读取 IndexedDB 中的真实数据，不使用任何内存缓存或占位值。
 */
export async function countByIndex(
  storeName: StoreName,
  indexName: string,
  query: IDBValidKey,
): Promise<number> {
  const db = await openDatabase();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const index = tx.objectStore(storeName).index(indexName);
    const request = index.count(query);
    tx.onerror = () => reject(tx.error ?? new Error('数据库统计失败。'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('数据库统计失败。'));
  });
}
