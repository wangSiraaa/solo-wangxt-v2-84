// Shared domain types. Everything in the app is local:
// OPFS holds file working bytes; IndexedDB holds only project metadata.

/** Column data types we expose to the user (a small subset of DuckDB types). */
export type ColumnType =
  | 'VARCHAR'
  | 'BIGINT'
  | 'INTEGER'
  | 'DOUBLE'
  | 'BOOLEAN'
  | 'DATE'
  | 'TIMESTAMP'
  | 'TIMESTAMPTZ';

export type FileKind = 'csv' | 'parquet';

export type ImportStatus = 'awaiting-file' | 'ready' | 'error';

export interface ColumnMeta {
  name: string;
  /** Type DuckDB inferred from the file (before user override). */
  inferredType: ColumnType;
  /** Effective type; when different from inferredType the user forced it. */
  type: ColumnType;
}

/** Metadata for one imported file. Persisted to IndexedDB. */
export interface FileMeta {
  id: string;
  fileName: string;
  kind: FileKind;
  size: number;
  /** SQL identifier for the view (e.g. "subjects"). */
  tableName: string;
  /** Path inside OPFS, e.g. "session/<id>.csv". */
  opfsPath: string;
  columns: ColumnMeta[];
  importedAt: number;
  /** Picked sample files are static app assets, not user files. */
  isSample: boolean;
  /** CSV only: sentinel token marking a NULL cell inside the rewritten file. */
  nullSentinel?: string;
}

export type JoinType = 'inner' | 'left' | 'right' | 'full';

export interface JoinStep {
  id: string;
  /** Table being joined into the result. */
  rightTable: string;
  joinType: JoinType;
  /** Equality pairs: left key expression (column of the running result) vs right column. */
  leftKey: string;
  rightKey: string;
}

export type QueryKind = 'select' | 'join';

export interface QueryDef {
  id: string;
  name: string;
  /** Editor mode last used for this query (persisted). */
  mode: 'builder' | 'sql';
  /** Raw SQL used by the editor / free-form mode. */
  sql: string;
  /** Base table for builder-style queries. */
  tableName: string;
  joins: JoinStep[];
  where: string;
  orderBy: string;
  limit: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMeta {
  version: 1;
  files: FileMeta[];
  queries: QueryDef[];
  activeQueryId: string | null;
}

export interface QueryResultColumn {
  name: string;
  /** DuckDB type name returned by arrow schema. */
  type: string;
}

export interface QueryResultPage {
  columns: QueryResultColumn[];
  /** Rows as plain JS values; null = SQL NULL, '' = empty string. */
  rows: unknown[][];
  totalRows: number;
  pageSize: number;
  page: number;
  pageCount: number;
  /** Milliseconds the count + page fetch took. */
  elapsedMs: number;
}

/** Per-step diagnostics for an equality join. */
export interface JoinDiagnostic {
  stepIndex: number; // 0 = base table
  leftTable: string;
  rightTable: string;
  joinType: JoinType;
  leftKey: string;
  rightKey: string;
  leftRowsBefore: number;
  resultRowsAfter: number;
  /** Distinct keys present only on the left/right side. */
  unmatchedLeftKeys: number;
  unmatchedRightKeys: number;
  /** Keys appearing on both sides with multiplicity > 1 somewhere. */
  manyToManyKeys: number;
  /** Rows contributed purely by fan-out vs a 1:1 join. */
  fanoutRows: number;
}

export interface ExecutionOutcome {
  page: QueryResultPage;
  diagnostics: JoinDiagnostic[];
}
