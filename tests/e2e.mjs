/** End-to-end browser verification with Playwright + the real DuckDB-Wasm.
 *
 * Acceptance scenarios:
 *  1. import samples (CSV + Parquet) -> columns + inferred types shown
 *  2. empty string vs NULL are distinguishable in results
 *  3. numeric column forced to VARCHAR (leading-zero preservation path)
 *  4. select / filter / one join / multiple joins examples run
 *  5. join diagnostics: row counts, unmatched keys, many-to-many fanout
 *  6. pagination + CSV export
 *  7. time-zone column rendered in Asia/Shanghai
 *  8. refresh restores query definitions from IndexedDB; restored query runs
 *     against the OPFS copy, and the UI never claims to re-read local files
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:4173';
const results = [];
function check(name, cond, detail = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) throw new Error(`FAILED: ${name} ${detail}`);
}

async function clickButton(page, text) {
  await page.getByRole('button', { name: text }).first().click();
}

async function waitReady(page) {
  await page.locator('.status.ready').waitFor({ timeout: 30000 });
}

async function loadSample(page, labelPart, table) {
  await page.getByRole('button', { name: new RegExp(labelPart) }).first().click();
  await page.locator('.file-card', { hasText: table }).first().waitFor({ timeout: 15000 });
}

async function runAndWait(page) {
  await clickButton(page, /运行查询/);
  // Wait until the run actually finishes (diagnostics run many queries);
  // a stale result header from a previous run may already be visible.
  await page.locator('[data-testid="run"][data-running="1"]').waitFor({ timeout: 5000 });
  await page.locator('[data-testid="run"][data-running="0"]').waitFor({ timeout: 30000 });
  await page.locator('.result-header').waitFor({ timeout: 20000 });
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (!/favicon|Failed to load resource/i.test(t)) errors.push(`console: ${t}`);
    }
  });

  await page.goto(BASE);
  await waitReady(page);
  check('engine ready', true);

  // --- 1. import ----------------------------------------------------------
  await loadSample(page, 'subjects.csv', 'subjects');
  await loadSample(page, 'visits.csv', 'visits');
  await loadSample(page, 'labs.parquet', 'labs');
  check('3 files imported', (await page.locator('.file-card').count()) >= 3);

  // parquet inferred types
  const labsCard = page.locator('.file-card', { hasText: 'labs.parquet' }).first();
  await labsCard.click();
  await labsCard.locator('.col-row').first().waitFor();
  const labsTypes = await labsCard.locator('.col-row').allInnerTexts();
  check('parquet TIMESTAMPTZ inferred', labsTypes.some((t) => t.includes('TIMESTAMPTZ')));
  check('parquet INTEGER inferred', labsTypes.some((t) => t.includes('INTEGER')));

  // --- 2. empty string vs NULL -------------------------------------------
  await page.locator('[data-testid=examples]').selectOption({ index: 1 }); // 选择+空串/NULL
  await runAndWait(page);
  const grid = page.locator('.table-scroll');
  const rows = await grid.locator('tbody tr').allInnerTexts();
  const wang = rows.find((r) => r.includes('Wang Fang'));
  const li = rows.find((r) => r.includes('Li Na') && !r.includes('dup'));
  check('Wang Fang note shows empty-string ""', !!wang && /""/.test(wang), wang ?? '');
  check('Li Na note shows NULL', !!li && /\bNULL\b/.test(li), li ?? '');
  check('row count = 7', /共\s*7\s*行/.test(await page.locator('.result-header').innerText()));

  // --- 3. force numeric column to text ------------------------------------
  await labsCard.locator('.col-row', { hasText: 'lab_id' }).locator('select').selectOption('VARCHAR');
  const overrideChip = await labsCard.locator('.col-row', { hasText: 'lab_id' }).innerText();
  check('lab_id override chip shown', overrideChip.includes('覆盖'));

  // --- 4-5. two-step join builder + diagnostics --------------------------
  await clickButton(page, '＋ 新查询');
  await page.locator('.builder').waitFor();
  await clickButton(page, /添加 JOIN/);
  const cards = page.locator('.join-card');
  await cards.nth(0).waitFor();
  await cards.nth(0).locator('select[data-key=jointype]').selectOption('left');
  await cards.nth(0).locator('select[data-key=righttable]').selectOption('visits');
  await cards.nth(0).locator('select[data-key=leftkey]').selectOption('subject_id');
  await cards.nth(0).locator('select[data-key=rightkey]').selectOption('subject_id');

  await clickButton(page, /添加 JOIN/);
  await page.locator('.join-card').nth(1).waitFor();
  const c2 = page.locator('.join-card').nth(1);
  await c2.locator('select[data-key=jointype]').selectOption('inner');
  await c2.locator('select[data-key=righttable]').selectOption('labs');
  await c2.locator('select[data-key=leftkey]').selectOption('visit_id');
  await c2.locator('select[data-key=rightkey]').selectOption('visit_id');

  await runAndWait(page);
  const wrap = page.locator('.results-wrap');
  check('two diagnostic cards', (await page.locator('.diag-card').count()) === 2);
  const cardsText = await wrap.locator('.diag-card').allInnerTexts();
  const c1 = cardsText[0];
  const c2text = cardsText[1];
  check('step1 left rows 7 -> 9', c1.includes('7') && c1.includes('9'), c1.replace(/\n/g, ' '));
  check('step1 unmatched left key = 1', /左侧未匹配键\s*1/.test(c1), c1.replace(/\n/g, ' '));
  check('step1 unmatched right key = 1', /右侧未匹配键\s*1/.test(c1));
  check('step1 many-to-many key = 1', /多对多重复键\s*1/.test(c1));
  check('step1 fanout +2', c1.includes('+2'));
  check('step2 result 10 rows', c2text.includes('10'), c2text.replace(/\n/g, ' '));
  check('header total = 10', /共\s*10\s*行/.test(await page.locator('.result-header').innerText()));

  // --- 7. timezone column -------------------------------------------------
  await page.locator('[data-testid=examples]').selectOption({ index: 5 }); // 时区列
  await runAndWait(page);
  const tzBody = await page.locator('.table-scroll').innerText();
  check('shanghai local 09:20 shown', tzBody.includes('2026-09-01 09:20:00'), tzBody.slice(0, 160));

  // --- 6. pagination ------------------------------------------------------
  await page.locator('[data-testid=examples]').selectOption({ index: 4 }); // 多个 JOIN
  await runAndWait(page);
  await page.locator('.pager select').selectOption('25');
  await page.waitForTimeout(400);
  await page.locator('.pager select').selectOption('5');
  await page.waitForFunction(
    () => document.querySelectorAll('table.grid tbody tr').length === 5,
    { timeout: 8000 },
  );
  check('page 1 shows 5 rows', (await page.locator('table.grid tbody tr').count()) === 5);
  check('total still 10', /共\s*10\s*行/.test(await page.locator('.result-header').innerText()));
  await clickButton(page, '下一页');
  await page.waitForFunction(
    () => document.querySelectorAll('table.grid tbody tr').length === 5 &&
      document.querySelector('.result-header')?.textContent?.includes('2 / 2'),
    { timeout: 5000 },
  );
  check('page 2/2 reached', true);

  // --- 6b. CSV export -----------------------------------------------------
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickButton(page, /导出 CSV/),
  ]);
  const fname = download.suggestedFilename();
  const stream = await download.createReadStream();
  const content = await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
  check('csv downloaded', fname.endsWith('.csv'), fname);
  check('csv has header and all 10 rows', (content.trim().split('\n').length) === 11,
    `${content.trim().split('\n').length} lines`);
  // labs.comment has '' rows (labs 10,13) -> quoted "" preserved; NULL rows bare empty
  check('export preserves quoted empty string', content.includes('""'));

  // --- 8. refresh: definitions restored, runs from OPFS, no re-read claim -
  await page.reload();
  await waitReady(page);
  await page.locator('.sql-tab').first().waitFor({ timeout: 10000 });
  check('query tabs restored', (await page.locator('.sql-tab').count()) >= 1);
  await page.waitForTimeout(2500); // let OPFS re-registration settle
  const sidebarHint = await page.locator('.sidebar .hint').first().innerText();
  check('sidebar honestly states local files are not re-read',
    /刷新后保留/.test(sidebarHint) && /不会自行重新读取磁盘上的原文件/.test(sidebarHint),
    sidebarHint);
  check('SQL mode persisted across reload',
    (await page.locator('button', { hasText: 'SQL' }).first().getAttribute('class'))?.includes('primary') ?? false);
  check('editor visible', await page.locator('.monaco-editor').isVisible());

  await clickButton(page, /运行查询/);
  await page.locator('.result-header').waitFor({ timeout: 20000 });
  check('restored query runs from OPFS copy (10 rows)',
    /共\s*10\s*行/.test(await page.locator('.result-header').innerText()));

  check('no unexpected console/page errors', errors.length === 0, errors.slice(0, 5).join('\n'));

  await browser.close();
  console.log('\n==== E2E RESULTS ====');
  console.log(results.join('\n'));
  console.log(`\nExported ${fname}:\n${content.slice(0, 500)}`);
  if (results.every((r) => r.startsWith('PASS'))) console.log('\nALL CHECKS PASSED');
  else process.exit(1);
}

main().catch((e) => {
  console.error('\n==== E2E RESULTS ====');
  console.log(results.join('\n'));
  console.error('\nE2E ERROR:', e);
  process.exit(1);
});
