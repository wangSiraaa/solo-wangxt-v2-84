/**
 * Generate the three sample datasets (no Python/pip needed):
 *   public/samples/subjects.csv
 *   public/samples/visits.csv
 *   public/samples/labs.parquet  (written by DuckDB itself, TIMESTAMPTZ column)
 *
 * Edge cases embedded on purpose:
 * - subjects.csv : leading-zero codes (zip, subject_id), TIMESTAMPTZ column,
 *                  quoted "" (empty string) vs unquoted empty (NULL) cells,
 *                  one duplicated key (many-side of an m:m join).
 * - visits.csv   : orphan key (S-999), unmatched left key (003),
 *                  duplicated key 002, unquoted empty score -> NULL.
 * - labs.parquet : TIMESTAMPTZ column, duplicated visit_id V2 (many-side that
 *                  pairs with duplicated 002 -> true many-to-many),
 *                  orphan V9, NULL and empty-string comments.
 */
const fs = require('node:fs');
const path = require('node:path');
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');

const DIST = path.join(__dirname, '..', 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
const OUT = path.join(__dirname, '..', 'public', 'samples');

async function openDb() {
  const db = await duckdb.createDuckDB(
    { mvp: { mainModule: path.join(DIST, 'duckdb-mvp.wasm'), mainWorker: path.join(DIST, 'duckdb-node-mvp.worker.cjs') } },
    new duckdb.ConsoleLogger(duckdb.LogLevel.NONE),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate(path.join(DIST, 'duckdb-mvp.wasm'));
  return db.connect();
}

function csvCell(v) {
  if (v === null || v === undefined) return '';            // unquoted empty -> NULL on read
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) {
    // Empty string must survive as a quoted "" cell (distinct from NULL).
    lines.push(r.map((v) => (v === '' ? '""' : csvCell(v))).join(','));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  writeCsv(path.join(OUT, 'subjects.csv'),
    ['subject_id', 'name', 'zip', 'birth_tz', 'note'],
    [
      ['001', 'Zhang Wei', '10001', '1985-03-14 08:30:00+08:00', 'active'],
      ['002', 'Li Na', '20002', '1990-07-21 13:05:00+08:00', null],
      ['002', 'Li Na (dup)', '20002', '1990-07-21 13:05:00+08:00', 'dup reg'],
      ['003', 'Wang Fang', '30003', '2001-11-02 22:15:00+08:00', ''],
      ['004', 'Chen Hao', '00450', '1978-01-30 05:45:00+08:00', 'active'],
      ['005', 'Liu Yang', '50005', '1995-09-09 19:00:00+08:00', null],
      ['10007', 'Zhao Min', '00700', '1988-12-25 11:30:00+08:00', 'active'],
    ]);

  writeCsv(path.join(OUT, 'visits.csv'),
    ['visit_id', 'subject_id', 'visit_time', 'score'],
    [
      ['V1', '001', '2026-09-01 09:00:00+08:00', '12.5'],
      ['V2', '002', '2026-09-02 10:30:00+08:00', '8.0'],
      ['V3', '002', '2026-09-03 11:15:00+08:00', '9.5'],
      ['V4', '004', '2026-09-04 14:20:00+08:00', null],
      ['V5', '005', '2026-09-05 16:40:00+08:00', '15.0'],
      ['V6', 'S-999', '2026-09-06 08:00:00+08:00', '7.0'],
      ['V7', '10007', '2026-09-07 18:00:00+08:00', '6.5'],
    ]);

  const conn = await openDb();
  conn.query(`
    CREATE TABLE labs (
      lab_id INTEGER,
      visit_id VARCHAR,
      drawn_at TIMESTAMPTZ,
      analyte VARCHAR,
      value DOUBLE,
      comment VARCHAR
    );
  `);
  const rows = [
    [10, 'V1', '2026-09-01 09:20:00+08:00', 'GLU', 5.1, ''],
    [11, 'V2', '2026-09-02 10:50:00+08:00', 'HGB', 132.0, null],
    [12, 'V2', '2026-09-02 12:10:00+08:00', 'PLT', 210.0, 'flag'],
    [13, 'V3', '2026-09-03 11:45:00+08:00', 'GLU', 5.8, ''],
    [14, 'V4', '2026-09-04 14:45:00+08:00', 'LDL', 3.2, null],
    [15, 'V5', '2026-09-05 17:00:00+08:00', 'GLU', 4.9, 'repeat'],
    [16, 'V9', '2026-09-08 08:30:00+08:00', 'HGB', 140.0, null],
    [17, 'V1', '2026-09-01 10:00:00+08:00', 'CRE', 78.0, 'fasting'],
  ];
  const stmt = conn.prepare('INSERT INTO labs VALUES (?, ?, ?::TIMESTAMPTZ, ?, ?, ?)');
  for (const r of rows) stmt.query(...r);
  const out = path.join(OUT, 'labs.parquet');
  if (fs.existsSync(out)) fs.rmSync(out);
  conn.query(`COPY labs TO '${out}' (FORMAT PARQUET, COMPRESSION SNAPPY)`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
