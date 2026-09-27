/**
 * 联结诊断全链路验证：真实 collectDiagnostics 代码（tsc 编译）
 *   × 真实 DuckDB-Wasm 引擎 × 真实示例数据 × 真实示例查询。
 * 运行：node scripts/verify-diagnostics.mjs
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/blocking');
const distDir = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const samplesDir = join(root, 'src', 'data', 'samples');
const out = mkdtempSync(join(tmpdir(), 'diag-test-'));

// 编译纯逻辑模块（diagnostics-core 依赖 joinparse/sqlutil/types）
execSync(
  `npx tsc src/lib/diagnostics-core.ts src/lib/joinparse.ts src/lib/sqlutil.ts --outDir ${JSON.stringify(out)} --module commonjs --target es2022 --moduleResolution node --skipLibCheck`,
  { cwd: root, stdio: 'inherit' },
);
const corePath = join(out, 'lib', 'diagnostics-core.js');
const { collectDiagnostics } = require(
  existsSync(corePath) ? corePath : join(out, 'diagnostics-core.js'),
);

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

const db = await duckdb.createDuckDB(
  { mvp: { mainModule: join(distDir, 'duckdb-mvp.wasm') }, eh: { mainModule: join(distDir, 'duckdb-eh.wasm') } },
  new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR),
  duckdb.NODE_RUNTIME,
);
await db.instantiate();
const conn = db.connect();

const CSV_OPTS = 'header=true, auto_detect=true, allow_quoted_nulls=false';
for (const f of ['customers.csv', 'orders.csv', 'promotions.csv', 'events.csv']) {
  db.registerFileBuffer(f, new Uint8Array(readFileSync(join(samplesDir, f))));
  conn.query(
    `CREATE OR REPLACE VIEW ${f.replace('.csv', '')} AS SELECT * FROM read_csv('${f}', ${CSV_OPTS})`,
  );
}

const count = async (sql) => {
  try {
    const t = conn.query(sql);
    return Number(t.getChildAt(0).get(0));
  } catch {
    return null;
  }
};

// 与应用 EXAMPLES 中 join1 / join2 完全一致的 SQL
const JOIN1_SQL = `SELECT o.order_id, o.customer_id, c.name, o.amount
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
ORDER BY o.order_id`;

const JOIN2_SQL = `SELECT o.order_id, c.name, p.label AS promo, o.amount
FROM orders o
JOIN customers c ON o.customer_id = c.customer_id
JOIN promotions p ON o.customer_id = p.customer_id
ORDER BY o.order_id, p.promo_id`;

console.log('\n== 单 JOIN 诊断全链路 ==');
{
  const d = await collectDiagnostics(JOIN1_SQL, count);
  check('解析成功', d.parsed === true, d.reason);
  check('1 个 JOIN', d.joins.length === 1);
  const j = d.joins[0];
  console.log('  ', JSON.stringify(j));
  check('左 7 行', j.leftRows === 7);
  check('右 5 行', j.rightRows === 5);
  check('联结后 6 行', j.joinedRows === 6);
  check('左未匹配 1（009）', j.unmatchedLeft === 1);
  check('右未匹配 2（004、005）', j.unmatchedRight === 2);
  check('左重复键 3', j.dupLeft === 3);
  check('右重复键 0', j.dupRight === 0);
  check('NULL 键均为 0', j.nullLeft === 0 && j.nullRight === 0);
  check('键归属确定', j.certain === true);
}

console.log('\n== 多 JOIN（多对多）诊断全链路 ==');
{
  const d = await collectDiagnostics(JOIN2_SQL, count);
  check('解析成功', d.parsed === true, d.reason);
  check('2 个 JOIN', d.joins.length === 2);
  const [j1, j2] = d.joins;
  check('JOIN#1: 7 → 6', j1.leftRows === 7 && j1.joinedRows === 6);
  check('JOIN#2: 6 → 8（多对多扇出 Δ+2）', j2.leftRows === 6 && j2.joinedRows === 8);
  check('JOIN#2 左重复键 3', j2.dupLeft === 3);
  check('JOIN#2 右重复键 2（001、004）→ 多对多', j2.dupRight === 2);
  check('JOIN#2 右未匹配 1（004 无订单）', j2.unmatchedRight === 1);
}

console.log('\n== 单表查询 ==');
{
  const d = await collectDiagnostics('SELECT * FROM orders WHERE amount > 1', count);
  check('识别为无 JOIN', d.parsed === true && d.joins.length === 0);
}

console.log('\n== 不可解析查询 ==');
{
  const d = await collectDiagnostics('SELECT 1', count);
  check('明确报告未解析', d.parsed === false && typeof d.reason === 'string');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败项:', failures.join('；'));
  process.exit(1);
}
