export type FileKind = 'csv' | 'parquet';

export interface ColumnMeta {
  name: string;
  /** 导入时 DuckDB 自动推断的类型 */
  inferredType: string;
  /** 用户覆盖类型（如把编号列设为 VARCHAR 保留前导零），null 表示使用推断类型 */
  override: string | null;
  /** 当前视图实际生效的类型 */
  effectiveType: string;
}

export interface FileMeta {
  id: string;
  /** 用户看到的原始文件名 */
  name: string;
  /** DuckDB 中的视图名 */
  viewName: string;
  /** 在 OPFS / DuckDB 文件系统中登记的名字 */
  regName: string;
  kind: FileKind;
  size: number;
  rowCount: number;
  importedAt: number;
  columns: ColumnMeta[];
  source: 'local' | 'sample';
}

export type FileStatus =
  | 'ready' // 本次会话内导入，可用
  | 'restored' // 刷新后从 OPFS 副本恢复，可用
  | 'missing'; // OPFS 副本缺失，需要用户重新选择本地文件

export interface FileState extends FileMeta {
  status: FileStatus;
  /** DuckDB 读取方式：opfs 直连或内存缓冲 */
  mode?: 'opfs' | 'memory';
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  updatedAt: number;
}

/** 结果表格单元格：显式区分 NULL 与空字符串 */
export type Cell =
  | { kind: 'null' }
  | { kind: 'empty' }
  | { kind: 'value'; text: string };

export interface ResultGrid {
  columns: { name: string; type: string }[];
  rows: Cell[][];
}

export interface JoinDiag {
  index: number;
  joinType: string;
  /** 例如 "orders o JOIN customers c ON o.customer_id = c.customer_id" */
  label: string;
  leftKey: string | null;
  rightKey: string | null;
  /** ON 条件是否能确定地解析出左右键 */
  certain: boolean;
  leftRows: number | null;
  rightRows: number | null;
  joinedRows: number | null;
  unmatchedLeft: number | null;
  unmatchedRight: number | null;
  dupLeft: number | null;
  dupRight: number | null;
  nullLeft: number | null;
  nullRight: number | null;
  error?: string;
}

export interface Diagnostics {
  parsed: boolean;
  reason?: string;
  joins: JoinDiag[];
}
