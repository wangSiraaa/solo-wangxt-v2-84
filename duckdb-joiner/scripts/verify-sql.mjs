/**
 * SQL 逻辑验证脚本（Node + 原生 DuckDB，引擎语义与 DuckDB-Wasm 一致）。
 * 验证内容：
 *  1. CSV 类型推断（前导零编号 → VARCHAR；纯数字编号 → BIGINT，可覆盖）
 *  2. types={...} 类型覆盖
 *  3. 空字符串（""）与 NULL 的区分（allow_quoted_nulls=false）
 *  4. 带时区时间戳的推断类型
 *  5. 联结诊断查询（未匹配键、重复键、行数变化、多对多扇出）
 *  6. 时区转换示例（AT TIME ZONE）
 *  7. COPY TO 导出（NULLSTR）与分页
 * 运行：npm run verify:sql
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const duckdb = require('duckdb');

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', 'src', 'data', 'samples');
const work = mkdtempSync(join(tmpdir(), 'verify-sql-'));

const db = new duckdb.Database(':memory:');
const con = db.connect();
const all = (sql) =>
  new Promise((resolve, reject) =>
    con.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))),
  );
const one = async (sql) => (await all(sql))[0];
const num = async (sql) => Number(Object.values(await one(sql))[0]);

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

// 与应用一致的 read_csv 参数
const CSV_OPTS = 'header=true, auto_detect=true, allow_quoted_nulls=false';

// 把示例 CSV 复制到临时目录（与应用使用同一批文件）
const csvFiles = readdirSync(samplesDir).filter((f) => f.endsWith('.csv'));
for (const f of csvFiles) {
  writeFileSync(join(work, f), readFileSync(join(samplesDir, f)));
}
const p = (f) => join(work, f).replace(/'/g, "''");

console.log('\n== 1. CSV 类型推断 ==');
{
  const rows = await all(`DESCRIBE SELECT * FROM read_csv('${p('orders.csv')}', ${CSV_OPTS})`);
  const cid = rows.find((r) => r.column_name === 'customer_id');
  const oid = rows.find((r) => r.column_name === 'order_id');
  const ts = rows.find((r) => r.column_name === 'order_ts');
  console.log('  orders:', rows.map((r) => `${r.column_name}:${r.column_type}`).join(', '));
  check(
    '前导零编号列被嗅探为 VARCHAR（前导零自动保留）',
    cid.column_type === 'VARCHAR',
    cid.column_type,
  );
  check('纯数字编号列（order_id）推断为 BIGINT', /BIGINT/.test(oid.column_type), oid.column_type);
  check('order_ts 推断为 TIMESTAMPTZ', /TIME ZONE/i.test(ts.column_type), ts.column_type);

  const row = await one(
    `SELECT customer_id FROM read_csv('${p('orders.csv')}', ${CSV_OPTS}) ORDER BY order_id LIMIT 1`,
  );
  check("读出 '001'（前导零保留）", row.customer_id === '001', `实际: ${row.customer_id}`);
}

console.log('\n== 2. types={...} 类型覆盖 ==');
{
  const rows = await all(
    `DESCRIBE SELECT * FROM read_csv('${p('orders.csv')}', ${CSV_OPTS}, types={'order_id': 'VARCHAR'})`,
  );
  const oid = rows.find((r) => r.column_name === 'order_id');
  const cid = rows.find((r) => r.column_name === 'customer_id');
  check('order_id 覆盖为 VARCHAR', oid.column_type === 'VARCHAR', oid.column_type);
  check('其余列仍自动推断（customer_id 保持 VARCHAR）', cid.column_type === 'VARCHAR');
  const row = await one(
    `SELECT order_id FROM read_csv('${p('orders.csv')}', ${CSV_OPTS}, types={'order_id': 'VARCHAR'}) ORDER BY order_id LIMIT 1`,
  );
  check("覆盖后读出字符串 '1001'", row.order_id === '1001', `实际: ${row.order_id}`);
}

console.log('\n== 3. 空字符串 vs NULL（allow_quoted_nulls=false）==');
{
  const rows = await all(
    `SELECT customer_id, email, email IS NULL AS isn, email = '' AS ise FROM read_csv('${p('customers.csv')}', ${CSV_OPTS}, types={'customer_id': 'VARCHAR'}) ORDER BY customer_id`,
  );
  const r002 = rows.find((r) => r.customer_id === '002');
  const r003 = rows.find((r) => r.customer_id === '003');
  check('002: "" 是空字符串而非 NULL', r002.isn === false && r002.ise === true, JSON.stringify(r002));
  check('003: 未加引号空字段是 NULL', r003.isn === true, JSON.stringify(r003));
}

console.log('\n== 4. 时区时间列推断 ==');
{
  const rows = await all(`DESCRIBE SELECT * FROM read_csv('${p('events.csv')}', ${CSV_OPTS})`);
  const col = rows.find((r) => r.column_name === 'happened_at');
  console.log('  events.happened_at 推断类型:', col.column_type);
  check('带偏移时间戳推断为 TIMESTAMPTZ', /TIME ZONE|TIMESTAMPTZ/i.test(col.column_type), col.column_type);
}

// 建视图（与应用一致）
for (const [view, file] of [
  ['customers', 'customers.csv'],
  ['orders', 'orders.csv'],
  ['promotions', 'promotions.csv'],
  ['events', 'events.csv'],
]) {
  await all(
    `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM read_csv('${p(file)}', ${CSV_OPTS})`,
  );
}

console.log('\n== 5. 联结诊断（单 JOIN：orders ⋈ customers）==');
{
  const L = 'orders o';
  const R = 'customers c';
  const lk = 'o.customer_id';
  const rk = 'c.customer_id';
  const leftRows = await num(`SELECT COUNT(*) AS c FROM ${L}`);
  const rightRows = await num(`SELECT COUNT(*) AS c FROM ${R}`);
  const joined = await num(`SELECT COUNT(*) AS c FROM ${L} JOIN ${R} ON ${lk} = ${rk}`);
  const unL = await num(
    `SELECT COUNT(*) AS c FROM (SELECT DISTINCT ${lk} FROM ${L} WHERE (${lk}) IS NOT NULL AND (${lk}) NOT IN (SELECT ${rk} FROM ${R} WHERE (${rk}) IS NOT NULL)) _u`,
  );
  const unR = await num(
    `SELECT COUNT(*) AS c FROM (SELECT DISTINCT ${rk} FROM ${R} WHERE (${rk}) IS NOT NULL AND (${rk}) NOT IN (SELECT ${lk} FROM ${L} WHERE (${lk}) IS NOT NULL)) _u`,
  );
  const dupL = await num(
    `SELECT COUNT(*) AS c FROM (SELECT ${lk} FROM ${L} WHERE (${lk}) IS NOT NULL GROUP BY ${lk} HAVING COUNT(*) > 1) _d`,
  );
  const dupR = await num(
    `SELECT COUNT(*) AS c FROM (SELECT ${rk} FROM ${R} WHERE (${rk}) IS NOT NULL GROUP BY ${rk} HAVING COUNT(*) > 1) _d`,
  );
  console.log(`  左 ${leftRows} 行, 右 ${rightRows} 行, 联结后 ${joined} 行, 未匹配 左${unL}/右${unR}, 重复键 左${dupL}/右${dupR}`);
  check('左侧 7 行', leftRows === 7);
  check('右侧 5 行', rightRows === 5);
  check('联结后 6 行（009 未匹配被丢弃）', joined === 6);
  check('左侧未匹配键 = 1（customer 009）', unL === 1);
  check('右侧未匹配键 = 2（004、005 无订单）', unR === 2);
  check('左侧重复键 = 3（001/002/003 各两单）', dupL === 3);
  check('右侧重复键 = 0', dupR === 0);
}

console.log('\n== 6. 多对多扇出（orders ⋈ promotions 及三表链式）==');
{
  const rightRows = await num(`SELECT COUNT(*) AS c FROM promotions p`);
  const dupR = await num(
    `SELECT COUNT(*) AS c FROM (SELECT p.customer_id FROM promotions p WHERE p.customer_id IS NOT NULL GROUP BY p.customer_id HAVING COUNT(*) > 1) _d`,
  );
  check('promotions 6 行', rightRows === 6);
  check('promotions 右侧重复键 = 2（001、004）→ 多对多', dupR === 2);

  const pairJoined = await num(
    `SELECT COUNT(*) AS c FROM orders o JOIN promotions p ON o.customer_id = p.customer_id`,
  );
  console.log(`  orders ⋈ promotions = ${pairJoined} 行（左侧 7 行，Δ ${pairJoined - 7}）`);
  check('成对联结 7 → 8 行（多对多扇出）', pairJoined === 8);

  const prefix1 = 'orders o JOIN customers c ON o.customer_id = c.customer_id';
  const chained = await num(
    `SELECT COUNT(*) AS c FROM ${prefix1} JOIN promotions p ON o.customer_id = p.customer_id`,
  );
  const leftRows = await num(`SELECT COUNT(*) AS c FROM ${prefix1}`);
  console.log(`  链式：${leftRows} → ${chained} 行（Δ ${chained - leftRows}）`);
  check('链式联结行数放大（6 → 8，Δ +2）', leftRows === 6 && chained === 8);
}

console.log('\n== 7. 时区转换示例 ==');
{
  const rows = await all(
    `SELECT event_id, happened_at,
            happened_at AT TIME ZONE 'Asia/Shanghai' AS sh,
            happened_at AT TIME ZONE 'UTC' AS utc
     FROM events ORDER BY event_id`,
  );
  const e3 = rows.find((r) => r.event_id === 'E3');
  const e4 = rows.find((r) => r.event_id === 'E4');
  console.log('  E3:', JSON.stringify(e3));
  console.log('  E4:', JSON.stringify(e4));
  check('AT TIME ZONE 可执行且返回 4 行', rows.length === 4);
  check(
    'E3(08:30+08:00) 与 E4(08:30Z) 是不同时刻（上海时间相差 8 小时）',
    String(e3.sh) !== String(e4.sh),
  );
}

console.log('\n== 8. 结果物化 + 分页 + 导出 ==');
{
  await all(
    `CREATE OR REPLACE TABLE __result AS SELECT o.order_id, c.name, o.amount FROM orders o JOIN customers c ON o.customer_id = c.customer_id ORDER BY o.order_id`,
  );
  const total = await num(`SELECT COUNT(*) AS c FROM __result`);
  const page = await all(`SELECT * FROM __result LIMIT 2 OFFSET 2`);
  check('物化结果 6 行', total === 6);
  check('分页 LIMIT/OFFSET 返回 2 行', page.length === 2);

  const out = join(work, 'export.csv');
  await all(
    `COPY (SELECT customer_id, email FROM customers ORDER BY customer_id) TO '${out.replace(/'/g, "''")}' (HEADER, NULLSTR 'NULL')`,
  );
  const csv = readFileSync(out, 'utf8');
  console.log('  导出内容:\n' + csv.split('\n').map((l) => '    ' + l).join('\n'));
  const lines = csv.trim().split('\n');
  const l002 = lines.find((l) => l.startsWith('002'));
  const l003 = lines.find((l) => l.startsWith('003'));
  check('NULL 行导出了字面量 NULL', !!l003 && l003.includes('NULL'), l003);
  check('空串行不含 NULL 标记（与 NULL 可区分）', !!l002 && !l002.includes('NULL'), l002);
}

console.log('\n== 9. 混合类型比较行为（VARCHAR 键 vs BIGINT 键）==');
{
  const r = await one(`SELECT '001' = 1 AS eq`);
  console.log(`  '001' = 1 →`, r.eq);
  check('DuckDB 隐式转换使跨类型比较为真', r.eq === true);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败项:', failures.join('；'));
  process.exit(1);
}
