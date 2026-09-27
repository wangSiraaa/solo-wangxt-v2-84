/** DuckDB-Wasm lifecycle, file registration, view DDL and query execution.
 *
 * Security/privacy: the engine only ever reads bytes from OPFS working files
 * that the user imported; there is no network/backend access.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdb_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?worker';
import type {
  ColumnMeta,
  ColumnType,
  FileKind,
  FileMeta,
  JoinDiagnostic,
  JoinStep,
  QueryResultColumn,
} from '../types';
import { opfsFileHandle } from './opfs';

/** Normalise a file name into a safe SQL view name; keeps unicode. */
export function tableNameFor(fileName: string, taken: Set<string>): string {
  const base = fileName
    .replace(/\.(csv|parquet)$/i, '')
    .toLowerCase()
    .replace(/[^0-9\p{L}_]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'table';
  const first = /^\d/.test(base) ? `t_${base}` : base;
  let name = first;
  let n = 2;
  while (taken.has(name)) name = `${first}_${n++}`;
  taken.add(name);
  return name;
}

export function qIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Column type DuckDB reports after a DESCRIBE query. */
export function mapDuckDbType(typeName: string): ColumnType {
  const t = typeName.toUpperCase();
  if (t.includes('TIMESTAMP WITH TIME ZONE') || t === 'TIMESTAMPTZ') return 'TIMESTAMPTZ';
  if (t.includes('TIMESTAMP')) return 'TIMESTAMP';
  if (t === 'DATE') return 'DATE';
  if (/(^|\W)DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC/.test(t)) return 'DOUBLE';
  if (t === 'BIGINT' || t.includes('HUGEINT') || t.includes('UBIGINT')) return 'BIGINT';
  if (t.includes('INT')) return 'INTEGER';
  if (t === 'BOOLEAN' || t === 'BOOL') return 'BOOLEAN';
  return 'VARCHAR';
}

export function makeNullSentinel(): string {
  // Extremely unlikely to collide with real data; never valid as number/date.
  return `__NULL_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}__`;
}

/** SQL that loads one OPFS working file into a typed relation.
 *
 * Each call registers the OPFS handle only for the duration of the load; the
 * relation itself is materialised as a DuckDB in-memory table, after which the
 * file handle is released. OPFS remains the durable working copy (rebuild on
 * refresh), while avoiding long-lived SyncAccessHandle locks.
 */
export function buildLoadSql(meta: FileMeta): string {
  const v = qIdent(meta.tableName);
  const src = `'opfs://${meta.opfsPath}'`;
  const selects = meta.columns.map((c) => {
    const col = qIdent(c.name);
    const needsCast = c.type !== c.inferredType;
    return `${needsCast ? `${col}::${c.type}` : col} AS ${col}`;
  });

  let body: string;
  if (meta.kind === 'parquet') {
    body = `SELECT ${selects.join(', ')} FROM read_parquet(${src})`;
  } else {
    // CSV files in OPFS were rewritten at import time: bare empty cells hold
    // the sentinel (read with nullstr) and quoted "" cells remain ''.
    const sentinel = meta.nullSentinel;
    body = `SELECT ${selects.join(', ')} FROM read_csv(${src}, header=>true, all_varchar=>true, nullstr=>${quoteString(sentinel ?? '')})`;
  }
  return `CREATE OR REPLACE TABLE ${v} AS ${body}`;
}

export class DuckEngine {
  private db: duckdb.AsyncDuckDB | null = null;
  private conn: duckdb.AsyncDuckDBConnection | null = null;
  private ready: Promise<void>;
  /** Serialize all worker-touching operations (a single connection is used). */
  private chain: Promise<unknown> = Promise.resolve();

  /** Run a piece of work strictly after any previously enqueued work. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work);
    // Keep the public chain from rejecting on an individual task failure.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const worker = new duckdb_worker();
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(duckdb_wasm);
    await db.open({
      path: ':memory:',
      query: { castTimestampToDate: true },
      opfs: { fileHandling: 'manual' },
    });
    this.db = db;
    this.conn = await db.connect();
  }

  /** @returns when engine is ready */
  waitReady(): Promise<void> {
    return this.ready;
  }

  /** Register an OPFS path with DuckDB via its FileSystemFileHandle. */
  private async registerOpfs(opfsPath: string): Promise<void> {
    const handle = await opfsFileHandle(opfsPath);
    await this.db!.registerFileHandle(
      `opfs://${opfsPath}`,
      handle,
      duckdb.DuckDBDataProtocol.BROWSER_FSACCESS,
      false,
    );
  }

  async dropFileRegistration(opfsPath: string): Promise<void> {
    await this.ready;
    await this.serialize(() => this.db!.dropFile(`opfs://${opfsPath}`).catch(() => {}));
  }

  /** Infer column name/type from a file-backed read expression. */
  private async describeRaw(sqlFrom: string): Promise<{ name: string; typeName: string }[]> {
    const t = await this.conn!.query(`DESCRIBE SELECT * FROM ${sqlFrom}`);
    const out: { name: string; typeName: string }[] = [];
    const c = t.toArray();
    for (let i = 0; i < t.numRows; i++) {
      const r = c[i].toJSON() as Record<string, unknown>;
      out.push({ name: String(r.column_name), typeName: String(r.column_type) });
    }
    return out;
  }

  /**
   * Import a Parquet working file in a single critical section: register the
   * OPFS handle once, infer its columns, materialise an in-memory table, then
   * release the handle. Repeated handle acquisition is what deadlocks.
   */
  async importParquetFile(meta: FileMeta): Promise<ColumnMeta[]> {
    await this.ready;
    return this.serialize(async () => {
      await this.registerOpfs(meta.opfsPath);
      try {
        const raw = await this.describeRaw(`read_parquet('opfs://${meta.opfsPath}')`);
        const columns: ColumnMeta[] = raw.map((c) => {
          const t = mapDuckDbType(c.typeName);
          return { name: c.name, inferredType: t, type: t };
        });
        await this.conn!.query(buildLoadSql({ ...meta, columns }));
        return columns;
      } finally {
        await this.db!.dropFile(`opfs://${meta.opfsPath}`).catch(() => {});
      }
    });
  }

  /**
   * Materialise an imported CSV file as an in-memory DuckDB table from its
   * OPFS working copy, then release the OPFS handle.
   */
  async loadTable(meta: FileMeta): Promise<void> {
    await this.ready;
    await this.serialize(async () => {
      await this.registerOpfs(meta.opfsPath);
      try {
        await this.conn!.query(buildLoadSql(meta));
      } finally {
        await this.db!.dropFile(`opfs://${meta.opfsPath}`).catch(() => {});
      }
    });
  }

  /** Rebuild the in-memory table on restore / type override. */
  async syncView(meta: FileMeta): Promise<void> {
    await this.loadTable(meta);
  }

  private async queryRaw(sql: string): Promise<{ columns: QueryResultColumn[]; rows: unknown[][] }> {
    const table = await this.conn!.query(sql);
    const columns: QueryResultColumn[] = table.schema.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
    }));
    // Arrow's browser build serialises temporal values to epoch numbers via
    // StructRow.toJSON (ms for Date64 / timestamps, days for Date32). Turn
    // them back into Date so the grid can render/format them uniformly.
    const temporal = columns.map((c) => {
      if (/^Date32/.test(c.type)) return 'days' as const;
      if (/Date64|Timestamp/.test(c.type)) return 'ms' as const;
      return null;
    });
    const rows: unknown[][] = [];
    const arr = table.toArray();
    for (let i = 0; i < table.numRows; i++) {
      const obj = arr[i].toJSON() as Record<string, unknown>;
      rows.push(columns.map((c, ci) => {
        const v = obj[c.name];
        if (v === null || v === undefined) return v;
        if (temporal[ci] === 'ms' && typeof v === 'number') return new Date(v);
        if (temporal[ci] === 'days' && typeof v === 'number') return new Date(v * 86_400_000);
        if (typeof v === 'bigint') return v.toString();
        return v;
      }));
    }
    return { columns, rows };
  }

  async queryArrow(sql: string): Promise<{ columns: QueryResultColumn[]; rows: unknown[][] }> {
    await this.ready;
    return this.serialize(() => this.queryRaw(sql));
  }

  /** Count rows of an arbitrary SELECT body (used for pagination totals). */
  async countSelect(sql: string): Promise<number> {
    await this.ready;
    const clean = sql.trim().replace(/;+\s*$/, '');
    const { rows } = await this.queryArrow(`SELECT count(*) AS n FROM (${clean}) _sub`);
    const v = rows[0][0];
    return typeof v === 'bigint' ? Number(v) : Number(v);
  }

  // ------------------------------------------------------------ diagnostics

  /**
   * Compute per-step join diagnostics for a builder query.
   * Each step compares the running CTE against the next table.
   */
  async joinDiagnostics(
    baseTable: string,
    steps: JoinStep[],
    ctes: { expr: string }[],
  ): Promise<JoinDiagnostic[]> {
    await this.ready;
    return this.serialize(() => this.joinDiagnosticsRaw(baseTable, steps, ctes));
  }

  private async joinDiagnosticsRaw(
    baseTable: string,
    steps: JoinStep[],
    ctes: { expr: string }[],
  ): Promise<JoinDiagnostic[]> {
    const out: JoinDiagnostic[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const prevCte = i === 0 ? 't0' : `t${i}`; // CTE holding rows BEFORE this join
      const leftKey = qIdent(step.leftKey);
      const rightKey = qIdent(step.rightKey);
      const rTable = qIdent(step.rightTable);
      const leftRows = await this.scalar(`SELECT count(*) FROM ${prevCte}`, ctes);
      const afterRows = await this.scalar(`SELECT count(*) FROM t${i + 1}`, ctes);
      const unmatchedLeft = await this.scalar(
        `SELECT count(DISTINCT ${prevCte}.${leftKey}) FROM ${prevCte}
           WHERE ${prevCte}.${leftKey} IS NOT NULL
             AND ${prevCte}.${leftKey} NOT IN
               (SELECT ${rightKey} FROM ${rTable} WHERE ${rightKey} IS NOT NULL)`,
        ctes,
      );
      const unmatchedRight = await this.scalar(
        `SELECT count(DISTINCT ${rTable}.${rightKey}) FROM ${rTable}
           WHERE ${rTable}.${rightKey} IS NOT NULL
             AND ${rTable}.${rightKey} NOT IN
               (SELECT ${leftKey} FROM ${prevCte} WHERE ${leftKey} IS NOT NULL)`,
        ctes,
      );
      const manyToManyKeys = await this.scalar(
        `SELECT count(*) FROM
           (SELECT ${leftKey} k FROM ${prevCte} WHERE ${leftKey} IS NOT NULL GROUP BY 1 HAVING count(*) > 1) l
           JOIN (SELECT ${rightKey} k FROM ${rTable} WHERE ${rightKey} IS NOT NULL GROUP BY 1 HAVING count(*) > 1) r
           ON l.k = r.k`,
        ctes,
      );
      const fanoutRows = await this.scalar(
        `SELECT coalesce(sum(lc * rc - lc), 0) FROM
           (SELECT ${leftKey} k, count(*) lc FROM ${prevCte} GROUP BY 1) l
           JOIN (SELECT ${rightKey} k, count(*) rc FROM ${rTable} GROUP BY 1) r ON l.k = r.k`,
        ctes,
      );
      out.push({
        stepIndex: i + 1,
        leftTable: i === 0 ? baseTable : `step ${i} result`,
        rightTable: step.rightTable,
        joinType: step.joinType,
        leftKey: step.leftKey,
        rightKey: step.rightKey,
        leftRowsBefore: leftRows,
        resultRowsAfter: afterRows,
        unmatchedLeftKeys: unmatchedLeft,
        unmatchedRightKeys: unmatchedRight,
        manyToManyKeys,
        fanoutRows,
      });
    }
    return out;
  }

  private async scalar(innerSql: string, ctes: { expr: string }[]): Promise<number> {
    const cteText = ctes.map((c) => c.expr).join(',\n');
    const sql = `WITH ${cteText} ${innerSql}`;
    const { rows } = await this.queryRaw(sql);
    const v = rows[0]?.[0];
    return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  }

  async terminate(): Promise<void> {
    if (this.db) await this.db.terminate();
  }
}

export type { FileKind };
