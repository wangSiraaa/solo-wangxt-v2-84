/** IndexedDB persistence for project metadata.
 *
 * Only metadata lives here (file descriptors, column settings, saved query
 * definitions). File bytes live in OPFS. No backend is involved.
 */
import type { ProjectMeta } from '../types';

const DB_NAME = 'research-assistant';
const STORE = 'meta';
const KEY = 'project-v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
        t.onerror = () => reject(t.error);
      }),
  );
}

export function emptyProject(): ProjectMeta {
  return { version: 1, files: [], queries: [], activeQueryId: null };
}

export async function loadProject(): Promise<ProjectMeta> {
  const stored = await tx('readonly', (s) => s.get(KEY) as IDBRequest<ProjectMeta | undefined>);
  return stored ?? emptyProject();
}

export async function saveProject(meta: ProjectMeta): Promise<void> {
  await tx('readwrite', (s) => s.put(meta, KEY));
}
