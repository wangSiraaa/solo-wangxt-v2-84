import type { FileMeta, SavedQuery } from '../types';

/**
 * IndexedDB：保存工程元数据（文件清单、列类型覆盖、查询定义）。
 * 不存文件内容本身 —— 文件字节在 OPFS。
 */

const DB_NAME = 'research-joiner';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_QUERIES = 'queries';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_QUERIES)) {
        db.createObjectStore(STORE_QUERIES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

async function put(store: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
}

async function del(store: string, key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 读取失败'));
  });
}

export const idb = {
  putFile: (f: FileMeta) => put(STORE_FILES, f),
  deleteFile: (id: string) => del(STORE_FILES, id),
  getAllFiles: () => getAll<FileMeta>(STORE_FILES),
  putQuery: (q: SavedQuery) => put(STORE_QUERIES, q),
  deleteQuery: (id: string) => del(STORE_QUERIES, id),
  getAllQueries: () => getAll<SavedQuery>(STORE_QUERIES),
};
