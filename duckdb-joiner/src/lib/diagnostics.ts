import type { Diagnostics } from '../types';
import { scalarNumber } from './duckdb';
import { collectDiagnostics } from './diagnostics-core';

/** 浏览器入口：用 DuckDB 连接执行诊断（核心逻辑在 diagnostics-core.ts） */
export async function runDiagnostics(sql: string): Promise<Diagnostics> {
  return collectDiagnostics(sql, async (q) => {
    try {
      return await scalarNumber(q);
    } catch {
      return null;
    }
  });
}
