/** Import pipeline: local File -> sniffed metadata -> OPFS working copy -> view.
 *
 * Bytes never leave the browser. CSV files are rewritten in a streaming pass
 * so bare empty cells become a per-file NULL sentinel (distinguishing NULL
 * from quoted empty strings); Parquet files are copied verbatim.
 */
import type { FileMeta } from '../types';
import { CsvNullRewriter, sniffCsv } from './csv';
import { DuckEngine, makeNullSentinel, tableNameFor } from './duckdb';
import { opfsWrite } from './opfs';

export interface ImportResult {
  meta: FileMeta;
}

export interface ImportHandle {
  kind: 'csv' | 'parquet';
  file: File;
  isSample: boolean;
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** First 256 KB are enough for header + 200-row sniffing in practice. */
async function sniffHead(file: File): Promise<string> {
  const head = await file.slice(0, 256 * 1024).text();
  return head;
}

async function importCsv(
  file: File,
  isSample: boolean,
  taken: Set<string>,
  engine: DuckEngine,
): Promise<FileMeta> {
  const head = await sniffHead(file);
  const sniff = sniffCsv(head);
  if (sniff.header.length === 0) throw new Error('CSV 缺少表头行');

  const id = uid();
  const opfsPath = `files/${id}.csv`;
  const nullSentinel = makeNullSentinel();

  // Streaming rewrite straight into OPFS (chunks keep memory flat).
  const rewriter = new CsvNullRewriter(nullSentinel);
  const writableChunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const reader = file.stream().getReader();
  const encoder = new TextEncoder();
  while (true) {
    const { done, value } = await reader.read();
    const text = decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const out = rewriter.push(text, done);
    if (out) writableChunks.push(encoder.encode(out));
    if (done) break;
  }
  const total = writableChunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of writableChunks) { merged.set(c, offset); offset += c.length; }
  await opfsWrite(opfsPath, merged);

  const meta: FileMeta = {
    id,
    fileName: file.name,
    kind: 'csv',
    size: file.size,
    tableName: tableNameFor(file.name, taken),
    opfsPath,
    columns: sniff.header.map((name, i) => ({
      name,
      inferredType: sniff.types[i],
      type: sniff.types[i],
    })),
    importedAt: Date.now(),
    isSample,
    nullSentinel,
  };
  await engine.syncView(meta);
  return meta;
}

async function importParquet(
  file: File,
  isSample: boolean,
  taken: Set<string>,
  engine: DuckEngine,
): Promise<FileMeta> {
  const id = uid();
  const opfsPath = `files/${id}.parquet`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await opfsWrite(opfsPath, bytes);
  const partial: FileMeta = {
    id,
    fileName: file.name,
    kind: 'parquet',
    size: file.size,
    tableName: tableNameFor(file.name, taken),
    opfsPath,
    columns: [],
    importedAt: Date.now(),
    isSample,
  };
  const columns = await engine.importParquetFile(partial);
  const meta = { ...partial, columns };
  return meta;
}

export async function importFile(
  handle: ImportHandle,
  taken: Set<string>,
  engine: DuckEngine,
): Promise<ImportResult> {
  const meta =
    handle.kind === 'csv'
      ? await importCsv(handle.file, handle.isSample, taken, engine)
      : await importParquet(handle.file, handle.isSample, taken, engine);
  return { meta };
}

/** Fetch a built-in sample from the app's own static assets. */
export async function fetchSample(name: string): Promise<File> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
  if (!res.ok) throw new Error(`无法加载样例 ${name}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type });
}
