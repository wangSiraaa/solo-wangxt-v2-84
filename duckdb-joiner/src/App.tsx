import { useCallback, useEffect, useRef, useState } from 'react';
import type { Diagnostics, FileState, ResultGrid, SavedQuery } from './types';
import { initDuckDB, exec, queryTable, scalarNumber } from './lib/duckdb';
import { idb } from './lib/idb';
import {
  applyOverride,
  importFile,
  rebindFile,
  removeFile,
  replaceFileBytes,
} from './lib/importer';
import { runDiagnostics } from './lib/diagnostics';
import { tableToGrid } from './lib/format';
import { exportFileName, exportResultCsv } from './lib/exporter';
import { stripTrailingSemicolons } from './lib/sqlutil';
import { EXAMPLES, SAMPLE_FILES } from './data/samples';
import { QueryEditor } from './components/QueryEditor';
import { FilePanel } from './components/FilePanel';
import { ResultsGrid } from './components/ResultsGrid';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';

const CURRENT_QUERY_ID = '__current__';
const DEFAULT_SQL = `-- 先点击「载入示例数据」或「导入文件」，再执行查询（Ctrl/Cmd+Enter）
${EXAMPLES[2].sql}
`;

interface ResultState {
  grid: ResultGrid;
  totalRows: number;
  page: number;
  pageSize: number;
  elapsedMs: number;
}

export default function App() {
  const [phase, setPhase] = useState<'init' | 'ready' | 'fatal'>('init');
  const [initError, setInitError] = useState<string | null>(null);
  const [duckVersion, setDuckVersion] = useState('');
  const [files, setFiles] = useState<FileState[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<ResultState | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const reimportTargetRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const filesRef = useRef<FileState[]>([]);
  filesRef.current = files;

  // ---------- 初始化：IDB → DuckDB → 从 OPFS 恢复文件 → 恢复查询定义 ----------
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        await idb.getAllFiles(); // 打开 IndexedDB
        const version = await initDuckDB();
        setDuckVersion(version);

        const savedFiles = await idb.getAllFiles();
        const restored: FileState[] = [];
        let restoredCount = 0;
        let missingCount = 0;
        for (const meta of savedFiles.sort((a, b) => a.importedAt - b.importedAt)) {
          const st = await rebindFile(meta);
          if (st.status === 'missing') missingCount++;
          else restoredCount++;
          restored.push(st);
        }
        setFiles(restored);

        const queries = await idb.getAllQueries();
        const current = queries.find((q) => q.id === CURRENT_QUERY_ID);
        if (current && current.sql.trim()) setSql(current.sql);
        setSavedQueries(
          queries.filter((q) => q.id !== CURRENT_QUERY_ID).sort((a, b) => b.updatedAt - a.updatedAt),
        );

        if (restoredCount > 0 || missingCount > 0) {
          const parts: string[] = [];
          if (restoredCount > 0) {
            parts.push(
              `已从浏览器本地存储（OPFS）恢复 ${restoredCount} 个文件的副本`,
            );
          }
          if (missingCount > 0) {
            parts.push(`${missingCount} 个文件的副本已缺失，请重新选择本地文件`);
          }
          parts.push(
            '注意：浏览器无法在未重新授权的情况下读取你磁盘上的原始文件；这里恢复的是导入时存入 OPFS 的副本，可能与磁盘最新内容不一致。',
          );
          setNotice(parts.join(''));
        }
        setPhase('ready');
      } catch (e) {
        setInitError(e instanceof Error ? e.message : String(e));
        setPhase('fatal');
      }
    })();
  }, []);

  // ---------- 查询定义持久化（防抖），刷新后恢复 ----------
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = setTimeout(() => {
      void idb.putQuery({ id: CURRENT_QUERY_ID, name: '当前查询', sql, updatedAt: Date.now() });
    }, 600);
    return () => clearTimeout(t);
  }, [sql, phase]);

  const persistFile = useCallback(async (f: FileState) => {
    const { status, mode, ...meta } = f;
    await idb.putFile(meta);
  }, []);

  // ---------- 文件导入 ----------
  const importBytes = useCallback(
    async (name: string, bytes: Uint8Array, source: 'local' | 'sample') => {
      const taken = filesRef.current.map((f) => f.viewName);
      const st = await importFile({ name, bytes, source }, taken);
      await persistFile(st);
      setFiles((prev) => [...prev, st]);
      return st;
    },
    [persistFile],
  );

  const onPickFiles = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (const file of Array.from(list)) {
          const lower = file.name.toLowerCase();
          if (!lower.endsWith('.csv') && !lower.endsWith('.parquet')) {
            setError(`不支持的文件类型：${file.name}（仅支持 .csv / .parquet）`);
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          await importBytes(file.name, bytes, 'local');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [importBytes],
  );

  const onLoadSamples = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      for (const s of SAMPLE_FILES) {
        await importBytes(s.name, new TextEncoder().encode(s.content), 'sample');
      }
      setNotice(
        '已载入 4 个示例表：customers / orders / promotions / events。' +
          'orders.customer_id 有重复键与未匹配键；promotions 与 orders 构成多对多；' +
          'events.happened_at 是带时区时间戳；customers.email 同时包含空字符串与 NULL。',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [importBytes]);

  const onRemoveFile = useCallback(
    async (id: string) => {
      const f = filesRef.current.find((x) => x.id === id);
      if (!f) return;
      setBusy(true);
      try {
        await removeFile(f);
        await idb.deleteFile(id);
        setFiles((prev) => prev.filter((x) => x.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onReimport = useCallback((id: string) => {
    reimportTargetRef.current = id;
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback(
    async (list: FileList | null) => {
      const target = reimportTargetRef.current;
      reimportTargetRef.current = null;
      if (target && list && list.length === 1) {
        // 重新选择磁盘文件，替换缺失/过期副本
        setBusy(true);
        setError(null);
        try {
          const meta = filesRef.current.find((x) => x.id === target);
          if (!meta) return;
          const bytes = new Uint8Array(await list[0].arrayBuffer());
          const st = await replaceFileBytes(meta, bytes);
          await persistFile(st);
          setFiles((prev) => prev.map((x) => (x.id === target ? st : x)));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
        return;
      }
      await onPickFiles(list);
    },
    [onPickFiles, persistFile],
  );

  // ---------- 列类型覆盖 ----------
  const onOverride = useCallback(
    async (fileId: string, column: string, type: string | null) => {
      const f = filesRef.current.find((x) => x.id === fileId);
      if (!f) return;
      setBusy(true);
      setError(null);
      try {
        const next = await applyOverride(f, column, type);
        const st: FileState = { ...f, ...next };
        await persistFile(st);
        setFiles((prev) => prev.map((x) => (x.id === fileId ? st : x)));
      } catch (e) {
        setError(
          `类型设置失败（已保留原设置）：${e instanceof Error ? e.message : String(e)}`,
        );
        // 刷新一次以回滚到持久化状态
        const saved = await idb.getAllFiles();
        const meta = saved.find((x) => x.id === fileId);
        if (meta) {
          setFiles((prev) => prev.map((x) => (x.id === fileId ? { ...x, ...meta } : x)));
        }
      } finally {
        setBusy(false);
      }
    },
    [persistFile],
  );

  // ---------- 查询执行 ----------
  const fetchPage = useCallback(async (page: number, pageSize: number): Promise<ResultGrid> => {
    const t = await queryTable(
      `SELECT * FROM __result LIMIT ${pageSize} OFFSET ${page * pageSize}`,
    );
    return tableToGrid(t);
  }, []);

  const onRun = useCallback(async () => {
    const cleaned = stripTrailingSemicolons(sql);
    if (!cleaned) return;
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      await exec(`CREATE OR REPLACE TABLE __result AS ${cleaned}`);
      const totalRows = await scalarNumber(`SELECT COUNT(*) AS c FROM __result`);
      const pageSize = result?.pageSize ?? 100;
      const grid = await fetchPage(0, pageSize);
      const elapsedMs = Math.round(performance.now() - t0);
      setResult({ grid, totalRows, page: 0, pageSize, elapsedMs });
      // 联结诊断失败不阻断结果展示
      try {
        setDiag(await runDiagnostics(cleaned));
      } catch {
        setDiag({ parsed: false, reason: '诊断执行失败', joins: [] });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
      setDiag(null);
    } finally {
      setBusy(false);
    }
  }, [sql, result?.pageSize, fetchPage]);

  const onPage = useCallback(
    async (page: number) => {
      if (!result) return;
      setBusy(true);
      try {
        const grid = await fetchPage(page, result.pageSize);
        setResult({ ...result, grid, page });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [result, fetchPage],
  );

  const onPageSize = useCallback(
    async (pageSize: number) => {
      if (!result) return;
      setBusy(true);
      try {
        const grid = await fetchPage(0, pageSize);
        setResult({ ...result, grid, page: 0, pageSize });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [result, fetchPage],
  );

  const onExport = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await exportResultCsv(exportFileName());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // ---------- 已保存查询 ----------
  const onSaveQuery = useCallback(async () => {
    const name = window.prompt('查询名称：', `查询 ${new Date().toLocaleString()}`);
    if (!name) return;
    const q: SavedQuery = {
      id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `q_${Date.now()}`,
      name,
      sql,
      updatedAt: Date.now(),
    };
    await idb.putQuery(q);
    setSavedQueries((prev) => [q, ...prev]);
  }, [sql]);

  const onLoadQuery = useCallback((q: SavedQuery) => setSql(q.sql), []);

  const onDeleteQuery = useCallback(async (id: string) => {
    await idb.deleteQuery(id);
    setSavedQueries((prev) => prev.filter((q) => q.id !== id));
  }, []);

  // ---------- 渲染 ----------
  if (phase === 'fatal') {
    return (
      <div className="fatal">
        <h1>初始化失败</h1>
        <p>{initError}</p>
        <p className="muted">请使用较新的 Chrome / Edge / Firefox，并确保允许使用 WebAssembly 与 Worker。</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <div className="title">
          <h1>本地数据联结工作台</h1>
          <span className="muted small">
            {phase === 'init' ? '正在启动 DuckDB-Wasm…' : `DuckDB ${duckVersion} · 纯浏览器运行，无后端、数据不上传`}
          </span>
        </div>
        <div className="actions">
          <button disabled={busy || phase !== 'ready'} onClick={() => { reimportTargetRef.current = null; fileInputRef.current?.click(); }}>
            导入文件
          </button>
          <button disabled={busy || phase !== 'ready'} onClick={onLoadSamples}>
            载入示例数据
          </button>
          <button disabled={busy || !result} onClick={onExport}>
            导出 CSV
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.parquet"
            multiple
            hidden
            onChange={(e) => {
              void onFileInputChange(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      {notice && (
        <div className="banner">
          <span>{notice}</span>
          <button className="link" onClick={() => setNotice(null)}>知道了</button>
        </div>
      )}
      {error && (
        <div className="banner error">
          <span>{error}</span>
          <button className="link" onClick={() => setError(null)}>关闭</button>
        </div>
      )}

      <div className="layout">
        <aside>
          <FilePanel
            files={files}
            busy={busy}
            onOverride={(fid, col, t) => void onOverride(fid, col, t)}
            onRemove={(id) => void onRemoveFile(id)}
            onReimport={onReimport}
          />
          <div className="panel">
            <h2>已保存查询</h2>
            <button disabled={busy} onClick={() => void onSaveQuery()}>保存当前查询</button>
            {savedQueries.length === 0 && <p className="muted small">暂无。编辑器内容会自动保存，刷新后恢复。</p>}
            <ul className="saved-queries">
              {savedQueries.map((q) => (
                <li key={q.id}>
                  <button className="link" onClick={() => onLoadQuery(q)}>{q.name}</button>
                  <span className="muted small">{new Date(q.updatedAt).toLocaleString()}</span>
                  <button className="link danger" onClick={() => void onDeleteQuery(q.id)}>删除</button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main>
          <div className="toolbar">
            <label>
              示例：{' '}
              <select
                defaultValue=""
                onChange={(e) => {
                  const ex = EXAMPLES.find((x) => x.id === e.target.value);
                  if (ex) setSql(ex.sql);
                  e.target.value = '';
                }}
              >
                <option value="" disabled>
                  选择示例插入编辑器…
                </option>
                {EXAMPLES.map((ex) => (
                  <option key={ex.id} value={ex.id} title={ex.note}>
                    {ex.title}
                  </option>
                ))}
              </select>
            </label>
            <span className="spacer" />
            <button className="primary" disabled={busy || phase !== 'ready'} onClick={() => void onRun()}>
              {busy ? '执行中…' : '执行 (Ctrl+Enter)'}
            </button>
          </div>

          <QueryEditor value={sql} onChange={setSql} onRun={() => void onRun()} />

          {result && (
            <div className="summary">
              结果：<strong>{result.totalRows}</strong> 行 × {result.grid.columns.length} 列 · 用时 {result.elapsedMs} ms
            </div>
          )}

          <DiagnosticsPanel diag={diag} resultRows={result ? result.totalRows : null} />

          {result && (
            <ResultsGrid
              grid={result.grid}
              totalRows={result.totalRows}
              page={result.page}
              pageSize={result.pageSize}
              onPage={(p) => void onPage(p)}
              onPageSize={(s) => void onPageSize(s)}
            />
          )}
        </main>
      </div>

      <footer className="muted small">
        所有计算在浏览器内完成（DuckDB-Wasm）。导入的文件字节保存在浏览器 OPFS 中，工程元数据（文件清单、列类型设置、查询定义）保存在 IndexedDB 中；
        刷新后从 OPFS 副本恢复工作文件并还原查询。浏览器不会、也无法在未重新授权的情况下读取你磁盘上的原始文件。
      </footer>
    </div>
  );
}
