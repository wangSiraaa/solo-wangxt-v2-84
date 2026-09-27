/**
 * 端到端冒烟测试（Playwright + 真实 Chromium）：
 *  1. 应用启动、DuckDB-Wasm 就绪
 *  2. 载入示例数据 → 文件列表显示列名与推断类型
 *  3. 列类型覆盖（order_id → VARCHAR）生效
 *  4. 执行多 JOIN 示例 → 行数、未匹配键、多对多诊断
 *  5. 空串/NULL 区分渲染
 *  6. 刷新后：查询定义恢复、文件从 OPFS 恢复
 * 运行：node scripts/e2e.mjs [baseURL]
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4173';

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

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200));
});

console.log('\n== 1. 启动 ==');
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=/DuckDB \\d/', { timeout: 120000 });
check('DuckDB-Wasm 就绪', true);

console.log('\n== 2. 载入示例数据 ==');
await page.click('button:has-text("载入示例数据")');
await page.waitForSelector('text=数据文件（4）', { timeout: 60000 });
check('4 个文件出现在列表中', true);
const ordersCard = page.locator('.file-card', { hasText: 'orders.csv' });
check(
  'orders.csv 显示行数 7',
  (await ordersCard.locator('.muted.small').first().innerText()).includes('7 行'),
);
check(
  '推断类型包含 TIMESTAMPTZ（order_ts）',
  await ordersCard.locator('.type-badge', { hasText: 'TIMESTAMP' }).first().isVisible(),
);
check(
  'customer_id 推断为 VARCHAR（前导零保留）',
  await ordersCard.locator('tr', { hasText: 'customer_id' }).locator('.type-badge', { hasText: 'VARCHAR' }).first().isVisible(),
);

console.log('\n== 3. 列类型覆盖 ==');
{
  const row = ordersCard.locator('tr', { hasText: 'order_id' }).first();
  await row.locator('select').selectOption('VARCHAR');
  await page.waitForSelector('.file-card tr:has-text("order_id") .type-badge.overridden', { timeout: 30000 });
  check('order_id 覆盖为 VARCHAR 后生效标记出现', true);
  // 改回自动
  await ordersCard.locator('tr', { hasText: 'order_id' }).first().locator('select').selectOption('');
  await page.waitForTimeout(800);
}

console.log('\n== 4. 多 JOIN 示例 + 联结诊断 ==');
await page.selectOption('.toolbar select', 'join2');
await page.click('button:has-text("执行")');
await page.waitForSelector('.summary', { timeout: 60000 });
const summary = await page.locator('.summary').innerText();
console.log('  ', summary);
check('结果 8 行（多对多扇出后）', summary.includes('8') && summary.includes('行'));
await page.waitForSelector('.join-card', { timeout: 60000 });
const joinCards = page.locator('.join-card');
check('显示 2 个 JOIN 诊断卡片', (await joinCards.count()) === 2, `实际 ${await joinCards.count()}`);
const card1 = await joinCards.nth(0).innerText();
const card2 = await joinCards.nth(1).innerText();
check('JOIN#1 行数变化 7 → 6', /7\s*→\s*6/.test(card1), card1.replace(/\n/g, ' | '));
check('JOIN#1 未匹配键 左 1 右 2', card1.includes('左 1') && card1.includes('右 2'), card1);
check('JOIN#2 行数变化 6 → 8（扇出）', /6\s*→\s*8/.test(card2), card2.replace(/\n/g, ' | '));
check('JOIN#2 标记为多对多', card2.includes('多对多'), card2);

console.log('\n== 5. 空串 vs NULL ==');
await page.selectOption('.toolbar select', 'nulls');
await page.click('button:has-text("执行")');
await page.waitForSelector('.summary', { timeout: 60000 });
const grid = page.locator('table.grid');
check('结果表渲染 NULL 徽标', (await grid.locator('.cell-null').count()) >= 1);
check('结果表渲染空串 "" 徽标', (await grid.locator('.cell-empty').count()) >= 1);

console.log('\n== 6. 时区示例 ==');
await page.selectOption('.toolbar select', 'tz');
await page.click('button:has-text("执行")');
await page.waitForSelector('.summary', { timeout: 60000 });
const tzText = await page.locator('.table-wrap').innerText();
check('结果包含 shanghai_time 列', tzText.includes('shanghai_time') || (await page.locator('th:has-text("shanghai_time")').count()) === 1);

console.log('\n== 7. 刷新恢复 ==');
await page.selectOption('.toolbar select', 'join1');
await page.waitForTimeout(1200); // 等待查询定义防抖保存
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=/DuckDB \\d/', { timeout: 120000 });
await page.waitForSelector('text=数据文件（4）', { timeout: 60000 });
check('刷新后文件从 OPFS 恢复', await page.locator('.badge', { hasText: '已从 OPFS 恢复' }).first().isVisible());
check(
  '刷新后提示不重新读取磁盘原件',
  await page.locator('.banner', { hasText: '无法在未重新授权' }).isVisible(),
);
const editorText = await page.locator('.editor-box').innerText();
check('刷新后恢复查询定义（join1 示例）', editorText.includes('JOIN customers'));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败项:', failures.join('；'));
  process.exit(1);
}
