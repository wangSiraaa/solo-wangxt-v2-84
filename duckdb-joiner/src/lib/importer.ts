import type { ColumnMeta, FileKind, FileMeta, FileState } from '../types';
import {
  dropWorkingFile,
  duckPathFor,
  exec,
  queryTable,
  registerWorkingFile,
  scalarNumber,
  type StorageMode,
} from './duckdb';
import { opfsDelete, opfsReadBytes, opfsSupported, opfsWrite } from './opfs';
import { quoteIdent, sanitizeViewName, sqlString } from './sqlutil';

/** 允许覆盖为的目标类型（下拉框选项） */
export const OVERRIDE_TYPES = [
  'VARCHAR',
  'BIGINT',
  'DOUBLE',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
  'TIMESTAMPTZ',
] as const;

type ModeAware = { regName: string; mode?: StorageMode };

/** 文件在 DuckDB 中的访问路径（取决于本次会话的登记方式） */
function duckPathOf(f: ModeAware): string {
  return duckPathFor(f.regName, f.mode ?? 'memory');
}

function readSourceSql(kind: FileKind, duckPath: string): string {
  // allow_quoted_nulls=false：引号包围的 "" 读为空字符串，未加引号的空字段仍为 NULL，
  // 从而区分"填写了空串"与"未填写"
  return kind === 'csv'
    ? `read_csv(${sqlString(duckPath)}, header=true, auto_detect=true, allow_quoted_nulls=false)`
    : `read_parquet(${sqlString(duckPath)})`;
}

/** 推断 CSV/Parquet 的列名与类型 */
export async function inferSchema(
  kind: FileKind,
  duckPath: string,
): Promise<{ name: string; type: string }[]> {
  const t = await queryTable(`DESCRIBE SELECT * FROM ${readSourceSql(kind, duckPath)}`);
  const nameCol = t.getChild('column_name');
  const typeCol = t.getChild('column_type');
  const out: { name: string; type: string }[] = [];
  for (let i = 0; i < t.numRows; i++) {
    out.push({ name: String(nameCol?.get(i)), type: String(typeCol?.get(i)) });
  }
  return out;
}

/**
 * 生成视图 SQL。
 * CSV：通过 read_csv 的 types={...} 覆盖指定列（其余列仍自动推断）。
 * Parquet：类型由文件决定，覆盖通过 CAST 实现。
 */
export function buildViewSql(file: FileMeta & ModeAware): string {
  const duckPath = duckPathOf(file);
  const overridden = file.columns.filter((c) => c.override);
  if (file.kind === 'csv') {
    const types =
      overridden.length > 0
        ? `, types={${overridden.map((c) => `${sqlString(c.name)}: '${c.override}'`).join(', ')}}`
        : '';
    return (
      `CREATE OR REPLACE VIEW ${quoteIdent(file.viewName)} AS ` +
      `SELECT * FROM read_csv(${sqlString(duckPath)}, header=true, auto_detect=true, allow_quoted_nulls=false${types})`
    );
  }
  if (overridden.length === 0) {
    return (
      `CREATE OR REPLACE VIEW ${quoteIdent(file.viewName)} AS ` +
      `SELECT * FROM ${readSourceSql('parquet', duckPath)}`
    );
  }
  const cols = file.columns
    .map((c) =>
      c.override
        ? `CAST(${quoteIdent(c.name)} AS ${c.override}) AS ${quoteIdent(c.name)}`
        : quoteIdent(c.name),
    )
    .join(', ');
  return (
    `CREATE OR REPLACE VIEW ${quoteIdent(file.viewName)} AS ` +
    `SELECT ${cols} FROM ${readSourceSql('parquet', duckPath)}`
  );
}

/** 读取视图当前实际的列类型（覆盖生效后的结果） */
async function describeView(viewName: string): Promise<Map<string, string>> {
  const t = await queryTable(`DESCRIBE SELECT * FROM ${quoteIdent(viewName)}`);
  const nameCol = t.getChild('column_name');
  const typeCol = t.getChild('column_type');
  const m = new Map<string, string>();
  for (let i = 0; i < t.numRows; i++) {
    m.set(String(nameCol?.get(i)), String(typeCol?.get(i)));
  }
  return m;
}

/**
 * （重新）创建视图并校验：COUNT(*) 会强制实际读取文件，
 * 类型覆盖不合法（如把非数字列转 BIGINT）会在这里抛错。
 * 成功后回填每列的 effectiveType 与总行数。
 */
export async function createAndValidateView<T extends FileMeta & ModeAware>(file: T): Promise<T> {
  await exec(buildViewSql(file));
  const rowCount = await scalarNumber(`SELECT COUNT(*) FROM ${quoteIdent(file.viewName)}`);
  const types = await describeView(file.viewName);
  const columns = file.columns.map((c) => ({
    ...c,
    effectiveType: types.get(c.name) ?? c.effectiveType,
  }));
  return { ...file, columns, rowCount };
}

function dedupeViewName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

export interface ImportInput {
  name: string;
  bytes: Uint8Array;
  source: 'local' | 'sample';
}

/**
 * 导入一个文件：写 OPFS 副本 → 登记进 DuckDB → 推断模式 → 建视图。
 */
export async function importFile(
  input: ImportInput,
  existingViewNames: string[],
): Promise<FileState> {
  const lower = input.name.toLowerCase();
  const kind: FileKind = lower.endsWith('.parquet') ? 'parquet' : 'csv';
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `f_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const regName = `f_${id}.${kind === 'csv' ? 'csv' : 'parquet'}`;

  // 1) 工作文件存入 OPFS（失败则仅本次会话可用）
  let hasOpfsCopy = false;
  if (opfsSupported()) {
    try {
      await opfsWrite(regName, input.bytes);
      hasOpfsCopy = true;
    } catch {
      hasOpfsCopy = false;
    }
  }

  // 2) 登记进 DuckDB（优先 OPFS 直连）
  const mode = await registerWorkingFile(regName, hasOpfsCopy, input.bytes);
  const duckPath = duckPathFor(regName, mode);

  // 3) 推断模式
  const inferred = await inferSchema(kind, duckPath);
  const columns: ColumnMeta[] = inferred.map((c) => ({
    name: c.name,
    inferredType: c.type,
    override: null,
    effectiveType: c.type,
  }));

  // 4) 建视图并校验
  const viewName = dedupeViewName(sanitizeViewName(input.name), new Set(existingViewNames));
  const meta: FileState = {
    id,
    name: input.name,
    viewName,
    regName,
    kind,
    size: input.bytes.byteLength,
    rowCount: 0,
    importedAt: Date.now(),
    columns,
    source: input.source,
    status: 'ready',
    mode,
  };
  return createAndValidateView(meta);
}

/**
 * 刷新后恢复：从 OPFS 副本读回字节并重建视图。
 * 注意：这里读取的是导入时存入浏览器存储的副本，
 * 不是用户磁盘上的原始文件 —— 浏览器无权在未重新授权时访问原文件。
 */
export async function rebindFile(meta: FileMeta): Promise<FileState> {
  const bytes = await opfsReadBytes(meta.regName);
  if (!bytes) {
    return { ...meta, status: 'missing' };
  }
  const mode = await registerWorkingFile(meta.regName, true, bytes);
  try {
    const validated = await createAndValidateView({ ...meta, status: 'restored' as const, mode });
    return validated;
  } catch {
    return { ...meta, status: 'missing' };
  }
}

/** 用户重新从磁盘选择文件，替换某个已缺失/过期的条目 */
export async function replaceFileBytes(meta: FileMeta, bytes: Uint8Array): Promise<FileState> {
  // 先从 DuckDB 注销（释放可能存在的 OPFS 同步句柄），再覆写 OPFS
  await dropWorkingFile(meta.regName);
  let hasOpfsCopy = false;
  if (opfsSupported()) {
    try {
      await opfsWrite(meta.regName, bytes);
      hasOpfsCopy = true;
    } catch {
      hasOpfsCopy = false;
    }
  }
  const mode = await registerWorkingFile(meta.regName, hasOpfsCopy, bytes);
  return createAndValidateView({
    ...meta,
    size: bytes.byteLength,
    status: 'ready',
    mode,
  });
}

/** 应用列类型覆盖并重建视图；失败时抛错，由调用方回滚 UI 状态 */
export async function applyOverride(
  meta: FileState,
  columnName: string,
  overrideType: string | null,
): Promise<FileState> {
  const next: FileState = {
    ...meta,
    columns: meta.columns.map((c) =>
      c.name === columnName ? { ...c, override: overrideType } : c,
    ),
  };
  return createAndValidateView(next);
}

export async function removeFile(meta: FileMeta): Promise<void> {
  try {
    await exec(`DROP VIEW IF EXISTS ${quoteIdent(meta.viewName)}`);
  } catch {
    // 视图可能不存在
  }
  await dropWorkingFile(meta.regName);
  await opfsDelete(meta.regName);
}
