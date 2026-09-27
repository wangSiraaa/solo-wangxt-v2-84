/** SQL 文本工具：注释剥离、顶层关键字扫描、标识符引用 */

/** 去掉 -- 与 块注释（跳过字符串/标识符引号内部） */
export function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (next === quote) {
          out += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 去掉末尾的分号（CREATE TABLE AS 包装用户 SQL 前需要） */
export function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/;+\s*$/, '').trim();
}

export interface TopLevelMatch {
  index: number;
  text: string;
}

/**
 * 在括号深度为 0、且不在引号内部的位置查找 pattern 的所有匹配。
 * 用于定位顶层 FROM / JOIN / WHERE 等关键字。
 */
export function findTopLevel(text: string, pattern: RegExp): TopLevelMatch[] {
  const flags = pattern.flags.includes('i') ? 'iy' : 'y';
  const re = new RegExp(pattern.source, flags);
  const matches: TopLevelMatch[] = [];
  let depth = 0;
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        if (text[i + 1] === quote) {
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m.index === i && m[0].length > 0) {
        matches.push({ index: i, text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return matches;
}

/** 双引号包裹的 SQL 标识符 */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** 单引号 SQL 字符串字面量 */
export function sqlString(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** 从文件名生成合法且稳定的视图名 */
export function sanitizeViewName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  let v = base.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!v) v = 't';
  if (/^[0-9]/.test(v)) v = 't_' + v;
  return v;
}
