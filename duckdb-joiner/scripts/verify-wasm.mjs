/**
 * Wasm 引擎级验证：用 duckdb-wasm 的 Node 阻塞构建（与浏览器同源 wasm），
 * 验证应用实际使用的 SQL 与文件登记路径。
 * 运行：node scripts/verify-wasm.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/blocking');
const distDir = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', 'src', 'data', 'samples');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

const bundles = {
  mvp: { mainModule: join(distDir, 'duckdb-mvp.wasm') },
  eh: { mainModule: join(distDir, 'duckdb-eh.wasm') },
};
const db = await duckdb.createDuckDB(
  bundles,
  new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR),
  duckdb.NODE_RUNTIME,
);
await db.instantiate();
console.log('DuckDB-Wasm version:', db.getVersion());

const conn = db.connect();
const q = (sql) => conn.query(sql);
const num = (sql) => {
  const t = q(sql);
  return Number(t.getChildAt(0).get(0));
};

// 与应用一致：registerFileBuffer + read_csv 参数
const CSV_OPTS = 'header=true, auto_detect=true, allow_quoted_nulls=false';
for (const f of ['customers.csv', 'orders.csv', 'promotions.csv', 'events.csv']) {
  db.registerFileBuffer(f, new Uint8Array(readFileSync(join(samplesDir, f))));
}

console.log('\n== A. 推断与覆盖（wasm）==');
{
  const t = q(`DESCRIBE SELECT * FROM read_csv('orders.csv', ${CSV_OPTS})`);
  const names = t.getChild('column_name');
  const types = t.getChild('column_type');
  const map = {};
  for (let i = 0; i < t.numRows; i++) map[String(names.get(i))] = String(types.get(i));
  console.log('  ', JSON.stringify(map));
  check('customer_id → VARCHAR（前导零保留）', map.customer_id === 'VARCHAR');
  check('order_id → BIGINT', /BIGINT/.test(map.order_id));
  check('order_ts → TIMESTAMPTZ', /TIME ZONE/i.test(map.order_ts));

  const v = q(
    `CREATE OR REPLACE VIEW orders AS SELECT * FROM read_csv('orders.csv', ${CSV_OPTS}, types={'order_id': 'VARCHAR'})`,
  );
  void v;
  const d = q(`DESCRIBE SELECT * FROM orders`);
  const tn = d.getChild('column_name');
  const tt = d.getChild('column_type');
  const m2 = {};
  for (let i = 0; i < d.numRows; i++) m2[String(tn.get(i))] = String(tt.get(i));
  check('视图覆盖 order_id → VARCHAR 生效', m2.order_id === 'VARCHAR', JSON.stringify(m2));
}

console.log('\n== B. 空串 vs NULL（wasm）==');
{
  q(`CREATE OR REPLACE VIEW customers AS SELECT * FROM read_csv('customers.csv', ${CSV_OPTS})`);
  const t = q(
    `SELECT customer_id, email IS NULL AS isn, email = '' AS ise FROM customers ORDER BY customer_id`,
  );
  const cid = t.getChild('customer_id');
  const isn = t.getChild('isn');
  const ise = t.getChild('ise');
  let ok002 = false;
  let ok003 = false;
  for (let i = 0; i < t.numRows; i++) {
    if (cid.get(i) === '002') ok002 = isn.get(i) === false && ise.get(i) === true;
    if (cid.get(i) === '003') ok003 = isn.get(i) === true;
  }
  check('002 为空字符串', ok002);
  check('003 为 NULL', ok003);
}

console.log('\n== C. 联结诊断查询（wasm）==');
{
  q(`CREATE OR REPLACE VIEW promotions AS SELECT * FROM read_csv('promotions.csv', ${CSV_OPTS})`);
  const prefix1 = 'orders o JOIN customers c ON o.customer_id = c.customer_id';
  const joined1 = num(`SELECT COUNT(*) AS c FROM ${prefix1}`);
  const chained = num(
    `SELECT COUNT(*) AS c FROM ${prefix1} JOIN promotions p ON o.customer_id = p.customer_id`,
  );
  const unL = num(
    `SELECT COUNT(*) AS c FROM orders o WHERE (o.customer_id) IS NOT NULL AND (o.customer_id) NOT IN (SELECT c.customer_id FROM customers c WHERE (c.customer_id) IS NOT NULL)`,
  );
  const dupR = num(
    `SELECT COUNT(*) AS c FROM (SELECT p.customer_id FROM promotions p WHERE p.customer_id IS NOT NULL GROUP BY p.customer_id HAVING COUNT(*) > 1) _d`,
  );
  console.log(`  join1=${joined1}, chained=${chained}, unmatchedLeft=${unL}, dupPromo=${dupR}`);
  check('JOIN#1 = 6 行', joined1 === 6);
  check('链式 = 8 行（多对多扇出）', chained === 8);
  check('左侧未匹配 = 1', unL === 1);
  check('promotions 重复键 = 2', dupR === 2);
}

console.log('\n== D. 时区（wasm，需 ICU）==');
{
  q(`CREATE OR REPLACE VIEW events AS SELECT * FROM read_csv('events.csv', ${CSV_OPTS})`);
  try {
    const t = q(
      `SELECT event_id, happened_at AT TIME ZONE 'Asia/Shanghai' AS sh FROM events ORDER BY event_id`,
    );
    check('AT TIME ZONE 在 wasm 中可用', t.numRows === 4);
  } catch (e) {
    check('AT TIME ZONE 在 wasm 中可用', false, e.message.split('\n')[0]);
  }
}

console.log('\n== E. 物化 + 分页 + 导出（wasm）==');
{
  q(
    `CREATE OR REPLACE TABLE __result AS SELECT o.order_id, c.name, o.amount FROM orders o JOIN customers c ON o.customer_id = c.customer_id ORDER BY o.order_id`,
  );
  check('物化 6 行', num(`SELECT COUNT(*) AS c FROM __result`) === 6);
  const page = q(`SELECT * FROM __result LIMIT 2 OFFSET 2`);
  check('分页返回 2 行', page.numRows === 2);

  let exported = false;
  try {
    q(`COPY (SELECT customer_id, email FROM customers ORDER BY customer_id) TO '__export.csv' (HEADER, NULLSTR 'NULL')`);
    const buf = db.copyFileToBuffer('__export.csv');
    const text = new TextDecoder().decode(buf);
    console.log('  导出预览:', JSON.stringify(text.split('\n').slice(0, 4)));
    exported = text.includes('NULL');
    db.dropFile('__export.csv');
  } catch (e) {
    console.log('  导出失败:', e.message.split('\n')[0]);
  }
  check('COPY TO + copyFileToBuffer 导出含 NULL 标记', exported);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败项:', failures.join('；'));
  process.exit(1);
}
