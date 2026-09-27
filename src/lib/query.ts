/** Build SQL from builder-style query definitions.
 *
 * Every join is modelled as a CTE (t0, t1, ...). This has two benefits:
 *  - diagnostics can inspect the running row count at every step;
 *  - duplicate column names from different tables never break later steps,
 *    because join keys are always qualified by the CTE / table alias.
 */
import type { JoinStep, QueryDef } from '../types';
import { qIdent } from './duckdb';

export interface BuiltSql {
  /** Full CTE text ending in a final SELECT from the last CTE. */
  sql: string;
  /** CTEs in chain order; diagnostics run queries against these. */
  ctes: { expr: string }[];
  /** Name of the last CTE (the result relation). */
  finalCte: string;
}

export function buildSql(q: QueryDef): BuiltSql {
  const ctes: { expr: string }[] = [];
  const base = qIdent(q.tableName);
  let prev = base;
  ctes.push({ expr: `t0 AS (SELECT * FROM ${base})` });

  q.joins.forEach((step: JoinStep, i: number) => {
    const next = `t${i + 1}`;
    const right = qIdent(step.rightTable);
    const on = `${prev}.${qIdent(step.leftKey)} = ${right}.${qIdent(step.rightKey)}`;
    ctes.push({
      expr:
        `${next} AS (SELECT * FROM ${prev} ` +
        `${step.joinType.toUpperCase()} JOIN ${right} ON ${on})`,
    });
    prev = next;
  });

  const finalCte = prev;
  const where = q.where.trim() ? ` WHERE ${q.where.trim()}` : '';
  const order = q.orderBy.trim() ? ` ORDER BY ${q.orderBy.trim()}` : '';
  const limit = q.limit != null && q.limit >= 0 ? ` LIMIT ${Math.floor(q.limit)}` : '';

  const sql =
    `WITH ${ctes.map((c) => c.expr).join(',\n')}\n` +
    `SELECT * FROM ${finalCte}${where}${order}${limit}`;
  return { sql, ctes, finalCte };
}

/** SQL string for a specific page of an arbitrary SELECT. */
export function pagedSql(sql: string, page: number, pageSize: number): string {
  const offset = page * pageSize;
  return `SELECT * FROM (${sql.trim().replace(/;+\s*$/, '')}) _paged LIMIT ${pageSize} OFFSET ${offset}`;
}
