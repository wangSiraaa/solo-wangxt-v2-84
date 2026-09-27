import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type {
  ColumnType,
  ExecutionOutcome,
  FileMeta,
  QueryDef,
} from './types';
import { DuckEngine } from './lib/duckdb';
import { buildSql, pagedSql } from './lib/query';
import { buildCsv, downloadText } from './lib/format';
import { setupMonaco } from './lib/monacoSetup';
import { useProject, newQuery } from './hooks/useProject';
import { FilePanel } from './components/FilePanel';
import { QueryBuilder } from './components/QueryBuilder';
import { ResultsTable } from './components/ResultsTable';
import { opfsDelete } from './lib/opfs';

setupMonaco();

const SAMPLE_QUERIES: { label: string; sql: string }[] = [
  {
    label: '选择 + 区分空串/NULL',
    sql: `SELECT "subject_id", "name", "zip", "note",
       "note" IS NULL AS note_is_null,
       "note" = ''    AS note_is_empty
FROM "subjects"
ORDER BY "subject_id";`,
  },
  {
    label: '过滤（非空且非空串）',
    sql: `SELECT "subject_id", "name", "zip"
FROM "subjects"
WHERE "zip" LIKE '0%' AND "note" IS NOT NULL AND "note" <> '';`,
  },
  {
    label: '一个 LEFT JOIN + 未匹配',
    sql: `WITH t0 AS (SELECT * FROM "subjects"),
t1 AS (
  SELECT * FROM t0
  LEFT JOIN "visits" ON t0."subject_id" = "visits"."subject_id"
)
SELECT * FROM t1
ORDER BY t0."subject_id"
LIMIT 1000;`,
  },
  {
    label: '多个 JOIN（受试者→就诊→化验）',
    sql: `WITH t0 AS (SELECT * FROM "subjects"),
t1 AS (SELECT * FROM t0 LEFT JOIN "visits" ON t0."subject_id" = "visits"."subject_id"),
t2 AS (SELECT * FROM t1 INNER JOIN "labs"  ON t1."visit_id"  = "labs"."visit_id")
SELECT t2."subject_id", t2."name", t2."visit_id",
       t2."lab_id", t2."analyte", t2."value",
       t2."drawn_at", t2."comment"
FROM t2
ORDER BY t2."lab_id"
LIMIT 1000;`,
  },
  {
    label: '时区列按上海时间显示',
    sql: `SELECT "lab_id", "drawn_at" AS utc_instant,
       ("drawn_at" AT TIME ZONE 'Asia/Shanghai') AS shanghai_local
FROM "labs"
ORDER BY "lab_id";`,
  },
];

export default function App() {
  const [engine] = useState(() => new DuckEngine());
  const engineRef = useRef<DuckEngine>(engine);
  const [engineState, setEngineState] = useState<'loading' | 'ready' | 'error'>('loading');

  const project = useProject();
  const meta = project.meta;

  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ExecutionOutcome | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const pageSizeRef = useRef(50);
  pageSizeRef.current = pageSize;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sqlText, setSqlText] = useState('');
  const sqlTextRef = useRef('');
  sqlTextRef.current = sqlText;
  const [mode, setMode] = useState<'builder' | 'sql'>('builder');
  const modeRef = useRef<'builder' | 'sql'>('builder');
  modeRef.current = mode;
  const [tz] = useState('Asia/Shanghai');
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);

  // ------------------------------------------------------------- engine boot
  useEffect(() => {
    engine
      .waitReady()
      .then(() => setEngineState('ready'))
      .catch((e) => {
        console.error(e);
        setEngineState('error');
      });
    return () => { void engine.terminate(); };
  }, [engine]);

  const files = meta?.files ?? [];
  const activeQuery: QueryDef | null = useMemo(() => {
    if (!meta?.activeQueryId) return null;
    return meta.queries.find((q) => q.id === meta.activeQueryId) ?? null;
  }, [meta]);
  const activeQueryRef = useRef<QueryDef | null>(activeQuery);
  activeQueryRef.current = activeQuery;

  // Once both engine and stored metadata are present, re-register OPFS files
  // and recreate views. Bytes are not re-read from disk.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (engineState !== 'ready' || !meta || restoredRef.current) return;
    restoredRef.current = true;
    (async () => {
      let missing = 0;
      for (const f of meta.files) {
        try {
          await engineRef.current!.syncView(f);
        } catch (e) {
          missing++;
          console.warn('恢复文件失败', f.fileName, e);
        }
      }
      if (meta.files.length > 0 && missing > 0) {
        setRestoreNotice(
          `已从 IndexedDB 恢复 ${meta.files.length} 个文件的定义，其中 ${missing} 个在 OPFS 中缺少工作副本。` +
          '刷新不会重新读取磁盘原文件；如需该数据请重新导入。',
        );
      }
      if (activeQuery) setSqlText(activeQuery.sql || buildSql(activeQuery).sql);
    })();
  }, [engineState, meta, activeQuery]);

  // Keep editor SQL + mode in sync when switching tabs.
  useEffect(() => {
    if (activeQuery) {
      setSqlText(activeQuery.sql || buildSql(activeQuery).sql);
      setMode(activeQuery.mode ?? 'builder');
    }
  }, [activeQuery?.id]);  // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------- mutations

  const persistQuery = useCallback(
    (patch: Partial<QueryDef>) => {
      if (!activeQuery) return;
      const next: QueryDef = { ...activeQuery, ...patch, updatedAt: Date.now() };
      project.upsertQuery(next);
    },
    [activeQuery, project],
  );

  const handleTypeChange = useCallback(
    async (fileId: string, columnName: string, type: ColumnType) => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;
      const columns = file.columns.map((c) => (c.name === columnName ? { ...c, type } : c));
      project.updateFile(fileId, { columns });
      try {
        await engineRef.current!.syncView({ ...file, columns });
        setError(null);
      } catch (e) {
        setError(`类型 ${type} 应用失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [files, project],
  );

  const handleImported = useCallback(
    (f: FileMeta) => {
      project.addFile(f);
      setActiveFileId(f.id);
      if (!activeQuery) {
        const q = newQuery(f.tableName, `${f.tableName} 浏览`);
        q.sql = buildSql(q).sql;
        project.upsertQuery(q);
      }
    },
    [activeQuery, project],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      const f = files.find((x) => x.id === id);
      project.removeFile(id);
      if (f) {
        await engineRef.current?.dropFileRegistration(f.opfsPath).catch(() => {});
        await opfsDelete(f.opfsPath).catch(() => {});
      }
    },
    [files, project],
  );

  const startQueryFor = useCallback(
    (tableName?: string) => {
      const q = newQuery(tableName ?? files[0]?.tableName ?? '');
      q.sql = buildSql(q).sql;
      project.upsertQuery(q);
      setMode('builder');
    },
    [files, project],
  );

  // ------------------------------------------------------------ execution

  const runPage = useCallback(
    async (sql: string, targetPage: number, size: number, diagnostics: ExecutionOutcome['diagnostics']) => {
      const engine = engineRef.current!;
      const t0 = performance.now();
      const totalRows = await engine.countSelect(sql);
      const pageCount = Math.max(1, Math.ceil(totalRows / size));
      const clamped = Math.min(targetPage, pageCount - 1);
      const { columns, rows } = await engine.queryArrow(pagedSql(sql, clamped, size));
      const elapsedMs = Math.round(performance.now() - t0);
      setPage(clamped);
      setOutcome({
        page: { columns, rows, totalRows, pageSize: size, page: clamped, pageCount, elapsedMs },
        diagnostics,
      });
    },
    [],
  );

  const execute = useCallback(async () => {
    const q0 = activeQueryRef.current;
    if (!q0 || !engineRef.current) return;
    setRunning(true);
    setError(null);
    try {
      const built = buildSql(q0);
      // Builder always runs from its current definition; SQL mode runs the
      // text currently in the editor.
      const sql = modeRef.current === 'builder' ? built.sql : sqlTextRef.current;
      if (modeRef.current === 'builder') setSqlText(built.sql);
      const diagnostics =
        modeRef.current === 'builder' && q0.joins.length > 0
          ? await engineRef.current.joinDiagnostics(q0.tableName, q0.joins, built.ctes)
          : [];
      await runPage(sql, 0, pageSizeRef.current, diagnostics);
      project.upsertQuery({ ...q0, sql, updatedAt: Date.now() });
    } catch (e) {
      console.error('[run]', e);
      setError(e instanceof Error ? e.message : String(e));
      setOutcome(null);
    } finally {
      setRunning(false);
    }
  }, [project, runPage]);

  const exportCsv = useCallback(async () => {
    const q0 = activeQueryRef.current;
    if (!outcome || !q0) return;
    // Export the FULL result set, not just the current page.
    const engine = engineRef.current!;
    const sql = modeRef.current === 'builder' ? buildSql(q0).sql : sqlTextRef.current;
    const { columns, rows } = await engine.queryArrow(
      pagedSql(sql, 0, Math.max(outcome.page.totalRows, 1)),
    );
    downloadText(`${q0.name.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.csv`, buildCsv(columns, rows));
  }, [outcome]);

  // ------------------------------------------------------------------ render

  if (!meta) {
    return <div className="empty-state">正在从 IndexedDB 恢复工程…</div>;
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>本地数据研究助理</h1>
        <span className="privacy">纯浏览器 · 无后端 · 数据不出本机</span>
        <span className="spacer" />
        <span className={`status ${engineState === 'ready' ? 'ready' : ''}`}>
          DuckDB-Wasm：{engineState === 'ready' ? '就绪' : engineState === 'loading' ? '加载中…' : '初始化失败'}
        </span>
      </div>

      <div className="layout">
        <FilePanel
          engine={engineRef.current}
          files={files}
          activeFileId={activeFileId}
          onSelect={setActiveFileId}
          onImported={handleImported}
          onTypeChange={handleTypeChange}
          onRemove={handleRemove}
        />

        <main className="main">
          <div className="sql-tabs">
            {meta.queries.map((q) => (
              <span
                key={q.id}
                className={`sql-tab ${activeQuery?.id === q.id ? 'active' : ''}`}
                onClick={() => project.setActiveQuery(q.id)}
              >
                {q.name}
              </span>
            ))}
            <button className="ghost" onClick={() => startQueryFor()} disabled={files.length === 0}>
              ＋ 新查询
            </button>
            <span className="spacer" style={{ flex: 1 }} />
            {activeQuery && (
              <>
                <button
                  className={mode === 'builder' ? 'primary' : ''}
                  onClick={() => { setMode('builder'); persistQuery({ mode: 'builder' }); }}
                >构建器</button>
                <button
                  className={mode === 'sql' ? 'primary' : ''}
                  onClick={() => { setMode('sql'); persistQuery({ mode: 'sql' }); }}
                >SQL</button>
                <button className="danger ghost" onClick={() => project.deleteQuery(activeQuery.id)}>
                  删除
                </button>
              </>
            )}
          </div>

          {restoreNotice && <div className="notice">{restoreNotice}</div>}

          {activeQuery ? (
            <>
              {mode === 'builder' && (
                <QueryBuilder
                  query={activeQuery}
                  files={files}
                  onChange={(merged) => {
                    project.upsertQuery({
                      ...merged,
                      sql: buildSql(merged).sql,
                      updatedAt: Date.now(),
                    });
                  }}
                  onGeneratedSql={() => {
                    setSqlText(buildSql(activeQuery).sql);
                    setMode('sql');
                  }}
                />
              )}

              <div className="builder-row" style={{ padding: '8px 16px', background: 'var(--panel)', borderBottom: '1px solid var(--border)' }}>
                <button
                  className="primary"
                  data-testid="run"
                  data-running={running ? '1' : '0'}
                  onClick={execute}
                  disabled={running || files.length === 0}
                >
                  {running ? '执行中…' : '▶ 运行查询'}
                </button>
                <button onClick={exportCsv} disabled={!outcome}>导出 CSV（全部结果）</button>
                <select
                  data-testid="examples"
                  onChange={(e) => {
                    const tpl = SAMPLE_QUERIES.find((s) => s.label === e.target.value);
                    if (tpl) {
                      setSqlText(tpl.sql);
                      setMode('sql');
                      const q0 = activeQueryRef.current;
                      if (q0) project.upsertQuery({ ...q0, sql: tpl.sql, mode: 'sql', updatedAt: Date.now() });
                    }
                    e.currentTarget.selectedIndex = 0;
                  }}
                  defaultValue=""
                >
                  <option value="">插入示例…</option>
                  {SAMPLE_QUERIES.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
                </select>
                <span className="hint">
                  空串与 NULL：<code className="k">IS NULL</code> 判断空值，<code className="k">= ''</code> 判断空字符串。
                </span>
              </div>

              <div className="editor-wrap">
                <Editor
                  theme="vs-dark"
                  language="sql"
                  value={sqlText}
                  onChange={(v) => setSqlText(v ?? '')}
                  onValidate={() => { /* syntax errors surface from DuckDB on run */ }}
                  options={{
                    fontSize: 13,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                  }}
                />
              </div>

              {error && <div className="error-box">{error}</div>}

              <div className="results-wrap">
                {outcome ? (
                  <ResultsTable
                    outcome={outcome}
                    tz={tz}
                    page={page}
                    pageSize={pageSize}
                    onPage={(p) => {
                      const q0 = activeQueryRef.current;
                      const sql = modeRef.current === 'builder' && q0 ? buildSql(q0).sql : sqlTextRef.current;
                      void runPage(sql, p, pageSizeRef.current, outcome.diagnostics);
                    }}
                    onPageSize={(n) => {
                      setPageSize(n);
                      pageSizeRef.current = n;
                      const q0 = activeQueryRef.current;
                      const sql = modeRef.current === 'builder' && q0 ? buildSql(q0).sql : sqlTextRef.current;
                      void runPage(sql, 0, n, outcome.diagnostics);
                    }}
                  />
                ) : (
                  <div className="empty-state">
                    导入文件后运行查询；结果将显示行数、未匹配键、多对多扇出诊断，并支持分页与导出。
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state">
              {files.length === 0
                ? '先从左侧导入 CSV / Parquet，或加载内置样例。'
                : '点击上方「＋ 新查询」开始。'}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
