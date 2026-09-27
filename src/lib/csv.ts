/** RFC 4180 CSV reader + the empty-field handling this app needs.
 *
 * DuckDB's CSV reader treats both unquoted empty cells and quoted "" cells as
 * NULL by default, and there is no parser flag to keep them apart. Research
 * data cares about the distinction, so before an uploaded CSV is copied into
 * OPFS we rewrite it:
 *   unquoted empty cell  -> unique NULL sentinel token  (read back as NULL)
 *   quoted "" cell       -> "" kept verbatim             (read back as '')
 *
 * The same single streaming pass also infers column types, so a 200 MB file
 * is never fully materialised in memory.
 */
import type { ColumnType } from '../types';

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

/** Parse a whole CSV string (used only on small inputs like samples). */
export function parseCsv(text: string): ParsedCsv {
  const it = iterRecords(text);
  const first = it.next();
  if (first.done) return { header: [], rows: [] };
  const header = first.value;
  const rows: string[][] = [];
  for (const rec of it) rows.push(rec);
  return { header, rows };
}

function* iterRecords(text: string): Generator<string[]> {
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let started = false; // anything written into the current record
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { record.push(field); field = ''; started = true; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      record.push(field); yield record;
      record = []; field = ''; started = false; continue;
    }
    if (c === '\n') {
      record.push(field); yield record;
      record = []; field = ''; started = false; continue;
    }
    field += c;
    started = true;
  }
  if (started || field !== '' || record.length > 0) {
    record.push(field);
    yield record;
  }
}

// ----------------------------------------------------------------- sniffing

const RE_INT = /^[+-]?\d+$/;
const RE_DOUBLE = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// 2026-09-01 09:00:00, optional T and optional timezone (Z or +08:00 / +08)
const RE_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
const RE_TSTZ = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

function rank(t: ColumnType): number {
  const order: Record<ColumnType, number> = {
    BOOLEAN: 1, INTEGER: 2, BIGINT: 3, DATE: 4, TIMESTAMP: 5,
    TIMESTAMPTZ: 6, DOUBLE: 7, VARCHAR: 8,
  };
  return order[t];
}

function mergeType(a: ColumnType, b: ColumnType): ColumnType {
  if (a === 'VARCHAR' || b === 'VARCHAR') return 'VARCHAR';
  // integer family merges to BIGINT once any value exceeds INT32.
  if ((a === 'INTEGER' || a === 'BIGINT') && (b === 'INTEGER' || b === 'BIGINT')) return 'BIGINT';
  if (a === 'DOUBLE' && (b === 'INTEGER' || b === 'BIGINT')) return 'DOUBLE';
  if (b === 'DOUBLE' && (a === 'INTEGER' || a === 'BIGINT')) return 'DOUBLE';
  return rank(a) >= rank(b) ? a : b;
}

function detectType(v: string): ColumnType {
  if (v === '' || RE_INT.test(v)) {
    if (v !== '') {
      const n = Number(v);
      if (Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647) return 'INTEGER';
      return 'BIGINT';
    }
  }
  if (v !== '' && (v === 'true' || v === 'false' || v === 'True' || v === 'False')) return 'BOOLEAN';
  if (RE_DATE.test(v)) return 'DATE';
  if (RE_TSTZ.test(v)) return 'TIMESTAMPTZ';
  if (RE_TS.test(v)) return 'TIMESTAMP';
  if (RE_DOUBLE.test(v)) return 'DOUBLE';
  return 'VARCHAR';
}

export interface SniffResult {
  header: string[];
  types: ColumnType[];
}

/** Infer column names/types from the first `maxRows` data rows of raw text. */
export function sniffCsv(text: string, maxRows = 200): SniffResult {
  const it = iterRecords(text);
  const first = it.next();
  if (first.done) return { header: [], types: [] };
  const header = first.value;
  const types: (ColumnType | null)[] = new Array(header.length).fill(null);
  let row = 0;
  for (const rec of it) {
    if (++row > maxRows) break;
    for (let c = 0; c < header.length; c++) {
      const v = rec[c] ?? '';
      if (v === '') continue; // NULL cells never influence inference
      const t = detectType(v);
      const cur = types[c];
      types[c] = cur === null ? t : mergeType(cur, t);
    }
  }
  return { header, types: types.map((t) => t ?? 'VARCHAR') };
}

// ------------------------------------------------------------- rewrite pass

/**
 * Streaming single-pass transformer. Copies CSV content byte-for-byte except
 * that a *bare* empty field (the cell was neither quoted nor had content) is
 * emitted as the NULL sentinel. Quoted "" stays "".
 *
 * Because the source can be a large file, callers push string chunks and
 * receive rewritten chunks.
 */
export class CsvNullRewriter {
  private out = '';
  private inQuotes = false;
  /** The current field has started (a quote seen or any content). */
  private fieldStarted = false;
  /** The current field had at least one content char. */
  private fieldHasContent = false;
  /** Current record has seen any char (so a trailing newline adds no record). */
  private recordHasChar = false;

  constructor(private readonly nullSentinel: string) {}

  push(chunk: string, final = false): string {
    let start = 0;
    const emit = (end: number, insert = '') => {
      this.out += chunk.slice(start, end) + insert;
      start = end;
    };
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.inQuotes) {
        if (c === '"') {
          if (chunk[i + 1] === '"') { i++; continue; }
          this.inQuotes = false;
        }
        continue;
      }
      if (c === '"') { this.inQuotes = true; this.fieldStarted = true; continue; }
      if (c === ',' || c === '\n' || c === '\r') {
        if (!this.fieldStarted && !this.fieldHasContent) emit(i, this.nullSentinel);
        this.fieldStarted = false;
        this.fieldHasContent = false;
        if (c === '\r' && chunk[i + 1] === '\n') i++;
        if (c === '\n' || c === '\r') this.recordHasChar = false;
      } else {
        this.fieldStarted = true;
        this.fieldHasContent = true;
        this.recordHasChar = true;
      }
    }
    emit(chunk.length);
    if (final && this.recordHasChar && !this.fieldStarted && !this.fieldHasContent) {
      // Last field of the final record is bare empty (no trailing newline).
      this.out += this.nullSentinel;
    }
    const result = this.out;
    this.out = '';
    return result;
  }
}

/** Convenience wrapper for small, already-loaded text. */
export function rewriteCsvNulls(text: string, sentinel: string): string {
  const r = new CsvNullRewriter(sentinel);
  return r.push(text, true);
}
