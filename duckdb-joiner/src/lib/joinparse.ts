import { findTopLevel, stripComments, stripTrailingSemicolons } from './sqlutil';

/**
 * FROM/JOIN 链解析（纯函数，不依赖 DuckDB，便于单测）。
 * 支持 `FROM t a JOIN u b ON a.k = b.k [JOIN ...]` 链式结构、单等值键；
 * 解析失败时返回 error，由调用方明确告知用户。
 */

const JOIN_RE = /\b(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?|INNER|CROSS)?\s*JOIN\b/i;
const BOUNDARY_RE =
  /;|\b(?:WHERE|HAVING|QUALIFY|WINDOW|GROUP\s+BY|ORDER\s+BY|LIMIT|UNION|EXCEPT|INTERSECT)\b/i;
const REF = '(?:"[^"]+"|[A-Za-z_][\\w$]*)(?:\\.(?:"[^"]+"|[A-Za-z_][\\w$]*))?';
const EQ_RE = new RegExp(`(${REF})\\s*=\\s*(${REF})`);
const TABLE_PART_RE =
  /^\s*("[^"]+"|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*(?:AS\s+)?("[^"]+"|[A-Za-z_][\w$]*)?\s*$/i;

export interface TableRef {
  raw: string;
  table: string;
  alias: string;
}

export interface JoinSegment {
  keyword: string;
  tableRef: TableRef | null;
  condRaw: string | null;
  leftKey: string | null;
  rightKey: string | null;
  certain: boolean;
  raw: string;
}

export interface ParsedFrom {
  base: TableRef;
  joins: JoinSegment[];
  /** prefix[i] = 到第 i 个 JOIN 为止的 FROM 片段（prefix[0] 仅基表） */
  prefixes: string[];
}

function unquote(ident: string): string {
  const t = ident.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
}

function parseTableRef(raw: string): TableRef | null {
  const m = TABLE_PART_RE.exec(raw);
  if (!m) return null;
  const table = unquote(m[1]);
  const alias = m[2] ? unquote(m[2]) : table;
  return { raw: raw.trim(), table, alias };
}

function qualifierOf(ref: string): string | null {
  const idx = ref.lastIndexOf('.');
  if (idx < 0) return null;
  return unquote(ref.slice(0, idx));
}

export function parseFromChain(sql: string): ParsedFrom | { error: string } {
  const clean = stripTrailingSemicolons(stripComments(sql));
  const froms = findTopLevel(clean, /\bFROM\b/i);
  if (froms.length === 0) return { error: '未找到顶层 FROM 子句' };
  const rest = clean.slice(froms[0].index + froms[0].text.length);
  const bounds = findTopLevel(rest, BOUNDARY_RE);
  const fromClause = rest.slice(0, bounds.length > 0 ? bounds[0].index : rest.length).trim();
  if (!fromClause) return { error: 'FROM 子句为空' };

  const joinMatches = findTopLevel(fromClause, JOIN_RE);
  const baseRaw = (
    joinMatches.length > 0 ? fromClause.slice(0, joinMatches[0].index) : fromClause
  ).trim();
  const base = parseTableRef(baseRaw);
  if (!base) {
    return { error: '暂不支持对子查询/函数作为基表的联结诊断（仅支持普通表或视图）' };
  }

  const aliasToTable = new Map<string, string>();
  aliasToTable.set(base.alias, base.table);
  aliasToTable.set(base.table, base.table);

  const joins: JoinSegment[] = [];
  for (let j = 0; j < joinMatches.length; j++) {
    const start = joinMatches[j].index + joinMatches[j].text.length;
    const end = j + 1 < joinMatches.length ? joinMatches[j + 1].index : fromClause.length;
    const segRaw = fromClause.slice(start, end).trim();
    const keyword = joinMatches[j].text.trim().replace(/\s+/g, ' ').toUpperCase();

    const onMatches = findTopLevel(segRaw, /\bON\b/i);
    if (onMatches.length === 0) {
      // CROSS JOIN 或 USING 语法：无法解析等值键
      const tableRef = parseTableRef(segRaw);
      joins.push({
        keyword,
        tableRef,
        condRaw: null,
        leftKey: null,
        rightKey: null,
        certain: false,
        raw: segRaw,
      });
      if (tableRef) {
        aliasToTable.set(tableRef.alias, tableRef.table);
        aliasToTable.set(tableRef.table, tableRef.table);
      }
      continue;
    }

    const tablePartRaw = segRaw.slice(0, onMatches[0].index).trim();
    const condRaw = segRaw.slice(onMatches[0].index + onMatches[0].text.length).trim();
    const tableRef = parseTableRef(tablePartRaw);
    if (tableRef) {
      aliasToTable.set(tableRef.alias, tableRef.table);
      aliasToTable.set(tableRef.table, tableRef.table);
    }

    let leftKey: string | null = null;
    let rightKey: string | null = null;
    let certain = false;
    const eq = EQ_RE.exec(condRaw);
    if (eq && tableRef) {
      const refA = eq[1];
      const refB = eq[2];
      const qA = qualifierOf(refA);
      const qB = qualifierOf(refB);
      const belongsToRight = (q: string | null) =>
        q !== null && (q === tableRef.alias || aliasToTable.get(q) === tableRef.table);
      if (belongsToRight(qA) && !belongsToRight(qB)) {
        rightKey = refA;
        leftKey = refB;
        certain = qB !== null;
      } else if (belongsToRight(qB) && !belongsToRight(qA)) {
        rightKey = refB;
        leftKey = refA;
        certain = qA !== null;
      } else {
        // 无法确定归属：按书写顺序，标注为不确定
        leftKey = refA;
        rightKey = refB;
        certain = false;
      }
    }
    joins.push({ keyword, tableRef, condRaw, leftKey, rightKey, certain, raw: segRaw });
  }

  // 构造前缀 FROM 片段：prefix[0] = 基表；prefix[k] = 到第 k 个 JOIN
  const prefixes: string[] = [base.raw];
  for (let j = 0; j < joins.length; j++) {
    const seg = joins[j];
    const prev = prefixes[prefixes.length - 1];
    if (seg.condRaw !== null && seg.tableRef) {
      // 直接用已解析的表片段，避免在 "promotions" 这类含 on 的标识符中误定位 ON
      prefixes.push(`${prev} ${seg.keyword} ${seg.tableRef.raw} ON ${seg.condRaw}`);
    } else {
      prefixes.push(`${prev} ${seg.keyword} ${seg.raw}`);
    }
  }

  return { base, joins, prefixes };
}
