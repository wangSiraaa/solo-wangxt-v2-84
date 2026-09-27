/** Client-side CSV export and display formatting.
 *
 * Export keeps the NULL / '' distinction explicit:
 *   NULL          -> bare empty cell
 *   ''            -> quoted ""
 * Same convention as the import samples.
 */
import type { QueryResultColumn } from '../types';

function toCsvField(v: unknown): string {
  if (v === null || v === undefined) return ''; // NULL -> bare empty cell
  if (v === '') return '""'; // empty string -> quoted, distinct from NULL
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'bigint') s = v.toString();
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(columns: QueryResultColumn[], rows: unknown[][]): string {
  const lines = [columns.map((c) => toCsvField(c.name)).join(',')];
  for (const row of rows) lines.push(row.map(toCsvField).join(','));
  return lines.join('\n') + '\n';
}

export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Format a DuckDB/arrow value for the grid. */
export function displayValue(v: unknown): { text: string; kind: 'null' | 'empty' | 'value' } {
  if (v === null || v === undefined) return { text: 'NULL', kind: 'null' };
  if (v instanceof Date) return { text: v.toISOString(), kind: 'value' };
  if (typeof v === 'bigint') return { text: v.toString(), kind: 'value' };
  if (v === '') return { text: '""', kind: 'empty' };
  return { text: String(v), kind: 'value' };
}

/** Render a timestamp in a chosen IANA zone, e.g. 2026-09-01 09:20:00 +08:00. */
export function formatInZone(date: Date, zone: string): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    });
    // en-CA gives YYYY-MM-DD; rebuild into "YYYY-MM-DD HH:MM:SS OFFSET".
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    let hh = get('hour');
    if (hh === '24') hh = '00';
    return `${get('year')}-${get('month')}-${get('day')} ${hh}:${get('minute')}:${get('second')} ${get('timeZoneName')}`;
  } catch {
    return date.toISOString();
  }
}
