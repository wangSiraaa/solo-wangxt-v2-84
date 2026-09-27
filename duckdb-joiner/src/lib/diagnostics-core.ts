import type { Diagnostics, JoinDiag } from '../types';
import { parseFromChain } from './joinparse';

/**
 * 联结诊断核心（纯逻辑，计数函数注入，便于在 Node 中用 wasm 引擎端到端测试）。
 * 对每个 JOIN 计算：
 *   - 左右输入行数、联结后行数（行数变化 = 多对多扇出 / 未匹配丢失）
 *   - 左右两侧未匹配键数量、重复键数量、NULL 键数量
 * 解析失败时明确告知而不是给出错误数字。
 */

export type CountFn = (sql: string) => Promise<number | null>;

export async function collectDiagnostics(sql: string, count: CountFn): Promise<Diagnostics> {
  const parsed = parseFromChain(sql);
  if ('error' in parsed) {
    return { parsed: false, reason: parsed.error, joins: [] };
  }
  if (parsed.joins.length === 0) {
    return { parsed: true, reason: '单表查询，无联结可诊断', joins: [] };
  }

  const out: JoinDiag[] = [];
  for (let j = 0; j < parsed.joins.length; j++) {
    const seg = parsed.joins[j];
    const leftFrom = parsed.prefixes[j]; // 该 JOIN 的左侧输入
    const rightFrom = seg.tableRef ? seg.tableRef.raw : null;
    const label = seg.tableRef
      ? `${seg.keyword} ${seg.tableRef.raw}${seg.condRaw ? ` ON ${seg.condRaw}` : ''}`
      : `${seg.keyword} ${seg.raw}`;

    const diag: JoinDiag = {
      index: j + 1,
      joinType: seg.keyword,
      label,
      leftKey: seg.leftKey,
      rightKey: seg.rightKey,
      certain: seg.certain,
      leftRows: null,
      rightRows: null,
      joinedRows: null,
      unmatchedLeft: null,
      unmatchedRight: null,
      dupLeft: null,
      dupRight: null,
      nullLeft: null,
      nullRight: null,
    };

    if (!rightFrom) {
      diag.error = '无法解析 JOIN 右侧表';
      out.push(diag);
      continue;
    }

    try {
      diag.leftRows = await count(`SELECT COUNT(*) AS c FROM ${leftFrom}`);
      diag.rightRows = await count(`SELECT COUNT(*) AS c FROM ${rightFrom}`);
      diag.joinedRows = await count(`SELECT COUNT(*) AS c FROM ${parsed.prefixes[j + 1]}`);

      const lk = seg.leftKey;
      const rk = seg.rightKey;
      if (lk && rk) {
        // 未匹配键按"不同键"计数（DISTINCT），与重复键统计口径一致
        diag.unmatchedLeft = await count(
          `SELECT COUNT(*) AS c FROM (SELECT DISTINCT ${lk} FROM ${leftFrom} ` +
            `WHERE (${lk}) IS NOT NULL AND (${lk}) NOT IN ` +
            `(SELECT ${rk} FROM ${rightFrom} WHERE (${rk}) IS NOT NULL)) _u`,
        );
        diag.unmatchedRight = await count(
          `SELECT COUNT(*) AS c FROM (SELECT DISTINCT ${rk} FROM ${rightFrom} ` +
            `WHERE (${rk}) IS NOT NULL AND (${rk}) NOT IN ` +
            `(SELECT ${lk} FROM ${leftFrom} WHERE (${lk}) IS NOT NULL)) _u`,
        );
        diag.dupLeft = await count(
          `SELECT COUNT(*) AS c FROM (SELECT ${lk} FROM ${leftFrom} ` +
            `WHERE (${lk}) IS NOT NULL GROUP BY ${lk} HAVING COUNT(*) > 1) _d`,
        );
        diag.dupRight = await count(
          `SELECT COUNT(*) AS c FROM (SELECT ${rk} FROM ${rightFrom} ` +
            `WHERE (${rk}) IS NOT NULL GROUP BY ${rk} HAVING COUNT(*) > 1) _d`,
        );
        diag.nullLeft = await count(
          `SELECT COUNT(*) AS c FROM ${leftFrom} WHERE (${lk}) IS NULL`,
        );
        diag.nullRight = await count(
          `SELECT COUNT(*) AS c FROM ${rightFrom} WHERE (${rk}) IS NULL`,
        );
      }
    } catch (e) {
      diag.error = e instanceof Error ? e.message : String(e);
    }
    out.push(diag);
  }

  return { parsed: true, joins: out };
}
