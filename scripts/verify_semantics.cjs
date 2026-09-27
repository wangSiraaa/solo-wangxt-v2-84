const path = require('node:path');
const dist = path.join('/workspace/node_modules/@duckdb/duckdb-wasm/dist');
const duckdb = require(path.join(dist, 'duckdb-node-blocking.cjs'));

(async () => {
  const db = await duckdb.createDuckDB(
    { mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: path.join(dist, 'duckdb-node-mvp.worker.cjs') } },
    new duckdb.ConsoleLogger(duckdb.LogLevel.NONE),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate(path.join(dist, 'duckdb-mvp.wasm'));
  const conn = db.connect();
  const q = (sql) => conn.query(sql);
  const show = (label, res) => {
    const cols = res.schema.fields.map(f => `${f.name}:${f.type}`);
    console.log(`\n== ${label}\n   ${cols.join(' | ')}`);
    for (const r of res.toArray()) console.log('  ', JSON.stringify(r.toJSON()));
  };

  // 1. auto sniff
  show('read_csv AUTO subjects', q(`
    SELECT * FROM read_csv('/workspace/public/samples/subjects.csv', header=>true) LIMIT 3`));
  // describe types
  show('DESCRIBE auto subjects', q(`
    DESCRIBE SELECT * FROM read_csv('/workspace/public/samples/subjects.csv', header=>true)`));

  // 2. all_varchar: '' vs NULL
  show('all_varchar note column', q(`
    SELECT subject_id, note, note IS NULL AS is_null, note = '' AS is_empty
    FROM read_csv('/workspace/public/samples/subjects.csv', header=>true, all_varchar=>true)`));

  // 3. view with casts (id forced VARCHAR keeps leading zero)
  q(`CREATE OR REPLACE VIEW subjects AS
     SELECT "subject_id"::VARCHAR AS "subject_id",
            "name"::VARCHAR AS "name",
            "zip"::VARCHAR AS "zip",
            "birth_tz"::TIMESTAMPTZ AS "birth_tz",
            "note"::VARCHAR AS "note"
     FROM read_csv('/workspace/public/samples/subjects.csv', header=>true, all_varchar=>true)`);
  show('view subjects', q(`SELECT * FROM subjects ORDER BY "name"`));

  // visits + labs
  q(`CREATE OR REPLACE VIEW visits AS
     SELECT "visit_id"::VARCHAR, "subject_id"::VARCHAR,
            "visit_time"::TIMESTAMPTZ, "score"::DOUBLE
     FROM read_csv('/workspace/public/samples/visits.csv', header=>true, all_varchar=>true)`);
  q(`CREATE OR REPLACE VIEW labs AS SELECT * FROM read_parquet('/workspace/public/samples/labs.parquet')`);
  show('labs schema+rows', q(`SELECT lab_id, visit_id, drawn_at, comment, comment IS NULL AS cnull FROM labs ORDER BY lab_id`));

  // 4. chained joins: subjects -> visits -> labs (ON qualified), duplicate stars
  show('3-table join', q(`
    WITH t0 AS (SELECT * FROM subjects),
    t1 AS (SELECT * FROM t0 INNER JOIN visits ON t0."subject_id" = visits."subject_id"),
    t2 AS (SELECT * FROM t1 INNER JOIN labs ON t1."visit_id" = labs."visit_id")
    SELECT count(*) AS n FROM t2`));
  const cols = q(`
    WITH t0 AS (SELECT * FROM subjects),
    t1 AS (SELECT * FROM t0 INNER JOIN visits ON t0."subject_id" = visits."subject_id"),
    t2 AS (SELECT * FROM t1 INNER JOIN labs ON t1."visit_id" = labs."visit_id")
    SELECT * FROM t2 LIMIT 2`);
  console.log('\n== t2 columns:', cols.schema.fields.map(f => f.name + ':' + f.type).join(' | '));

  // 5. diagnostics for step subjects->visits
  show('diag step1', q(`
    WITH t0 AS (SELECT * FROM subjects)
    SELECT
      (SELECT count(*) FROM t0) AS left_rows,
      (SELECT count(*) FROM t0 INNER JOIN visits ON t0."subject_id"=visits."subject_id") AS after_rows,
      (SELECT count(DISTINCT k) FROM (SELECT t0."subject_id" k FROM t0
         WHERE t0."subject_id" IS NOT NULL
           AND t0."subject_id" NOT IN (SELECT "subject_id" FROM visits WHERE "subject_id" IS NOT NULL))) AS unmatched_left,
      (SELECT count(DISTINCT k) FROM (SELECT visits."subject_id" k FROM visits
         WHERE visits."subject_id" IS NOT NULL
           AND visits."subject_id" NOT IN (SELECT "subject_id" FROM t0 WHERE "subject_id" IS NOT NULL))) AS unmatched_right,
      (SELECT count(*) FROM
         (SELECT t0."subject_id" k, count(*) c FROM t0 GROUP BY 1 HAVING count(*)>1) lc
         JOIN (SELECT "subject_id" k, count(*) c FROM visits GROUP BY 1 HAVING count(*)>1) rc USING(k)) AS m2m,
      (SELECT coalesce(sum(lc*rc-lc),0) FROM
         (SELECT "subject_id" k, count(*) lc FROM t0 GROUP BY 1) l
         JOIN (SELECT "subject_id" k, count(*) rc FROM visits GROUP BY 1) r USING(k)) AS fanout`));

  // 6. TIMESTAMPTZ arrow value type
  const tz = q(`SELECT drawn_at FROM labs WHERE lab_id=10`);
  const v = tz.toArray()[0].toJSON();
  console.log('\n== timestamptz JS value:', v.drawn_at, v.drawn_at instanceof Date ? v.drawn_at.toISOString() : typeof v.drawn_at);

  // 7. CSV export semantics: COPY ... TO STDOUT?
  try {
    const exp = q(`COPY (SELECT 1 AS a, NULL AS b, '' AS c) TO STDOUT (FORMAT CSV, HEADER)`);
    console.log('\n== COPY STDOUT type:', exp.constructor.name);
  } catch (e) { console.log('\nCOPY STDOUT failed:', e.message); }

  // 8. count + pagination
  show('limit/offset', q(`SELECT * FROM subjects LIMIT 2 OFFSET 1`));
  process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
