import { getConn, getDb } from './duckdb';

/**
 * 把当前结果表 __result 导出为 CSV 并触发浏览器下载。
 * 通过 DuckDB 的 COPY TO 写入其文件系统，再取回字节。
 * NULL 导出为字面量 NULL，与空字符串（导出为空）区分开。
 */
export async function exportResultCsv(fileName: string): Promise<void> {
  const conn = getConn();
  const db = getDb();
  const tmp = '__export.csv';
  try {
    await conn.query(`COPY (SELECT * FROM __result) TO '${tmp}' (HEADER, NULLSTR 'NULL')`);
  } catch {
    // 旧版本不支持 NULLSTR 选项时退回普通导出
    await conn.query(`COPY (SELECT * FROM __result) TO '${tmp}' (HEADER)`);
  }
  const bytes = await db.copyFileToBuffer(tmp);
  try {
    await db.dropFile(tmp);
  } catch {
    // 忽略清理失败
  }
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportFileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `result_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
}
