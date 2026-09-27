import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { OPFS_DIR } from './opfs';

export type ArrowTable = Awaited<ReturnType<duckdb.AsyncDuckDBConnection['query']>>;

export type StorageMode = 'opfs' | 'memory';

/** DuckDB 中引用工作文件的路径：OPFS 直连用 opfs:// URL，内存缓冲用登记名 */
export function duckPathFor(regName: string, mode: StorageMode): string {
  return mode === 'opfs' ? `opfs://${OPFS_DIR}/${regName}` : regName;
}

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let initPromise: Promise<string> | null = null;

/** 初始化 DuckDB-Wasm（幂等），返回版本号 */
export function initDuckDB(): Promise<string> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const bundles: duckdb.DuckDBBundles = {
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    };
    const bundle = await duckdb.selectBundle(bundles);
    const worker = new Worker(bundle.mainWorker!);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const instance = new duckdb.AsyncDuckDB(logger, worker);
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);
    db = instance;
    conn = await instance.connect();
    return instance.getVersion();
  })();
  return initPromise;
}

export function getDb(): duckdb.AsyncDuckDB {
  if (!db) throw new Error('DuckDB 尚未初始化');
  return db;
}

export function getConn(): duckdb.AsyncDuckDBConnection {
  if (!conn) throw new Error('DuckDB 尚未初始化');
  return conn;
}

export async function exec(sql: string): Promise<void> {
  await getConn().query(sql);
}

export async function queryTable(sql: string): Promise<ArrowTable> {
  return getConn().query(sql);
}

/** 取单个数值结果（COUNT 等），BIGINT 转 number */
export async function scalarNumber(sql: string): Promise<number> {
  const t = await getConn().query(sql);
  const col = t.getChildAt(0);
  if (!col || t.numRows === 0) return 0;
  const v = col.get(0);
  if (v == null) return 0;
  return Number(v);
}

/**
 * 把工作文件登记进 DuckDB 文件系统。
 * 优先通过 opfs:// URL 直连（DuckDB 在 Worker 内用同步句柄流式读取 OPFS），
 * 失败则退回内存缓冲（registerFileBuffer）。
 * 前提：OPFS 副本已写入（调用方保证）。
 */
export async function registerWorkingFile(
  regName: string,
  hasOpfsCopy: boolean,
  bytes: Uint8Array,
): Promise<StorageMode> {
  const d = getDb();
  if (hasOpfsCopy) {
    try {
      await d.registerOPFSFileName(duckPathFor(regName, 'opfs'));
      return 'opfs';
    } catch {
      // 某些环境（非安全上下文、旧浏览器）OPFS 不可用，退回内存
    }
  }
  await d.registerFileBuffer(regName, bytes);
  return 'memory';
}

export async function dropWorkingFile(regName: string): Promise<void> {
  const d = getDb();
  // 两种登记名都尝试清理；OPFS 直连持有的同步句柄也会随之释放
  for (const name of [regName, duckPathFor(regName, 'opfs')]) {
    try {
      await d.dropFile(name);
    } catch {
      // 未登记则忽略
    }
  }
}

/** 把 DuckDB 文件系统里的文件读成字节（用于 COPY TO 导出后取回） */
export async function readWorkingFile(name: string): Promise<Uint8Array> {
  return getDb().copyFileToBuffer(name);
}
