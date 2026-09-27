/**
 * JOIN 解析器单元测试（纯函数）。
 * 运行：node scripts/test-parser.mjs
 * （先由 npm run build:test 编译，见 package.json；或直接 node --experimental-strip-types 不可用时用 tsc）
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'parser-test-'));

// 只编译纯函数模块（无 wasm/资源导入）
execSync(
  `npx tsc src/lib/joinparse.ts src/lib/sqlutil.ts --outDir ${JSON.stringify(out)} --module commonjs --target es2022 --moduleResolution node --skipLibCheck`,
  { cwd: join(here, '..'), stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const { parseFromChain } = require(join(out, 'joinparse.js'));

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

console.log('\n== 单 JOIN ==');
{
  const p = parseFromChain(
    `SELECT o.order_id, c.name FROM orders o JOIN customers c ON o.customer_id = c.customer_id ORDER BY o.order_id;`,
  );
  check('解析成功', !('error' in p), JSON.stringify(p));
  if (!('error' in p)) {
    check('1 个 JOIN', p.joins.length === 1);
    check('基表 orders / 别名 o', p.base.table === 'orders' && p.base.alias === 'o');
    check('右表 customers / 别名 c', p.joins[0].tableRef.table === 'customers');
    check('左键 o.customer_id', p.joins[0].leftKey === 'o.customer_id');
    check('右键 c.customer_id', p.joins[0].rightKey === 'c.customer_id');
    check('键归属确定', p.joins[0].certain === true);
    check(
      'prefix[1] 正确',
      p.prefixes[1] === 'orders o JOIN customers c ON o.customer_id = c.customer_id',
      p.prefixes[1],
    );
  }
}

console.log('\n== 多 JOIN 链 ==');
{
  const p = parseFromChain(
    `SELECT o.order_id, c.name, p.label
     FROM orders o
     JOIN customers c ON o.customer_id = c.customer_id
     JOIN promotions p ON o.customer_id = p.customer_id
     ORDER BY o.order_id, p.promo_id;`,
  );
  check('解析成功', !('error' in p), JSON.stringify(p));
  if (!('error' in p)) {
    check('2 个 JOIN', p.joins.length === 2);
    check('JOIN#2 左键 o.customer_id', p.joins[1].leftKey === 'o.customer_id');
    check('JOIN#2 右键 p.customer_id', p.joins[1].rightKey === 'p.customer_id');
    check(
      'prefix[2] 含两个 JOIN',
      p.prefixes[2].includes('JOIN customers') && p.prefixes[2].includes('JOIN promotions'),
      p.prefixes[2],
    );
    check('prefix[2] 不含 ORDER BY', !/ORDER\s+BY/i.test(p.prefixes[2]));
  }
}

console.log('\n== 键顺序颠倒（右表键写在前面）==');
{
  const p = parseFromChain(`SELECT * FROM orders o JOIN customers c ON c.customer_id = o.customer_id`);
  if (!('error' in p)) {
    check('左键仍解析为 o.customer_id', p.joins[0].leftKey === 'o.customer_id');
    check('右键仍解析为 c.customer_id', p.joins[0].rightKey === 'c.customer_id');
  } else {
    check('解析成功', false, p.error);
  }
}

console.log('\n== LEFT JOIN / 注释 / WHERE 边界 ==');
{
  const p = parseFromChain(
    `-- 注释 JOIN 干扰
     SELECT * FROM orders o LEFT JOIN customers c ON o.customer_id = c.customer_id WHERE o.amount > 1`,
  );
  if (!('error' in p)) {
    check('识别 LEFT JOIN', p.joins[0].keyword === 'LEFT JOIN', p.joins[0].keyword);
    check('cond 不含 WHERE', !/WHERE/i.test(p.joins[0].condRaw), p.joins[0].condRaw);
  } else {
    check('解析成功', false, p.error);
  }
}

console.log('\n== 无 JOIN 单表 ==');
{
  const p = parseFromChain(`SELECT * FROM orders WHERE amount > 1`);
  check('解析成功且 0 个 JOIN', !('error' in p) && p.joins.length === 0);
}

console.log('\n== 子查询基表 → 明确报错 ==');
{
  const p = parseFromChain(`SELECT * FROM (SELECT 1 AS a) t JOIN customers c ON t.a = c.customer_id`);
  check('返回 error 而不是错误数字', 'error' in p);
}

console.log('\n== 字符串字面量中的 JOIN 不干扰 ==');
{
  const p = parseFromChain(
    `SELECT * FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE c.name = 'JOIN x ON y'`,
  );
  check('仅 1 个 JOIN', !('error' in p) && p.joins.length === 1);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败项:', failures.join('；'));
  process.exit(1);
}
