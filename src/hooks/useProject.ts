import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FileMeta,
  ProjectMeta,
  QueryDef,
} from '../types';
import { emptyProject, loadProject, saveProject } from '../lib/idb';

/** Project metadata state with debounced persistence to IndexedDB.
 *
 * Synchronous mutations within the same tick chain through a ref holding the
 * latest pending project, so e.g. "addFile + upsertQuery" cannot overwrite
 * each other with a stale snapshot.
 */
export function useProject() {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const pendingRef = useRef<ProjectMeta | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadProject().then((loaded) => {
      pendingRef.current = loaded;
      setMeta(loaded);
    });
  }, []);

  const mutate = useCallback((fn: (m: ProjectMeta) => ProjectMeta) => {
    const base = pendingRef.current ?? emptyProject();
    const next = fn(structuredClone(base));
    pendingRef.current = next; // synchronously visible to the next mutate()
    setMeta(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveProject(next); }, 250);
  }, []);

  const addFile = useCallback(
    (file: FileMeta) => mutate((m) => ({ ...m, files: [...m.files, file] })),
    [mutate],
  );

  const removeFile = useCallback(
    (id: string) =>
      mutate((m) => ({ ...m, files: m.files.filter((f) => f.id !== id) })),
    [mutate],
  );

  const updateFile = useCallback(
    (id: string, patch: Partial<FileMeta>) =>
      mutate((m) => ({
        ...m,
        files: m.files.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      })),
    [mutate],
  );

  const upsertQuery = useCallback(
    (q: QueryDef) =>
      mutate((m) => {
        const exists = m.queries.some((x) => x.id === q.id);
        return {
          ...m,
          queries: exists
            ? m.queries.map((x) => (x.id === q.id ? q : x))
            : [...m.queries, q],
          activeQueryId: q.id,
        };
      }),
    [mutate],
  );

  const deleteQuery = useCallback(
    (id: string) =>
      mutate((m) => ({
        ...m,
        queries: m.queries.filter((q) => q.id !== id),
        activeQueryId: m.activeQueryId === id ? null : m.activeQueryId,
      })),
    [mutate],
  );

  const setActiveQuery = useCallback(
    (id: string | null) => mutate((m) => ({ ...m, activeQueryId: id })),
    [mutate],
  );

  return {
    meta,
    addFile,
    removeFile,
    updateFile,
    upsertQuery,
    deleteQuery,
    setActiveQuery,
  };
}

export function newQuery(tableName: string, name?: string): QueryDef {
  const now = Date.now();
  return {
    id: `q-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: name ?? `查询 ${new Date(now).toLocaleTimeString()}`,
    mode: 'builder',
    sql: '',
    tableName,
    joins: [],
    where: '',
    orderBy: '',
    limit: 1000,
    createdAt: now,
    updatedAt: now,
  };
}
