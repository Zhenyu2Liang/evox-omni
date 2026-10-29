/** Real-browser report acceptance, with an isolated SQLite fixture and no model calls. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright-core';
import { bootDevServer, launchBrowser, resolveBrowserExecutable, REPO_ROOT, waitForElementHydration, type DevServer } from './helpers';
import { cliCommand, ensurePrismaClientGenerated, provisionSchemaLadder, resolveTsxBin, runCliStep } from '../helpers/prisma-cli';
import { createTranslator } from '../../lib/i18n/shared';
import { formatCNY } from '../../lib/money';
import { THEME_COOKIE } from '../../lib/theme/shared';

const evidenceDir = path.join(REPO_ROOT, 'logs', 'bill-reports');
mkdirSync(evidenceDir, { recursive: true });
const liveAnalysis = process.env.BILL_REPORT_LIVE === '1';
process.env.LLM_MODE = liveAnalysis ? 'live' : 'mock';
process.env.DATABASE_URL = `file:${path.join(REPO_ROOT, 'prisma', 'bill-report-e2e.db').replaceAll('\\', '/')}`;
process.env.CHECKPOINT_DISABLE = '1';
process.env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
process.env.CI = '1';
const passed: string[] = [];
const zh = createTranslator('zh-CN'), en = createTranslator('en');
let server: DevServer | undefined;
let browser: Browser | undefined;
try {
  ensurePrismaClientGenerated(REPO_ROOT);
  // Default to a fresh production build: SQLite writes during dev can trigger HMR refreshes.
  // CI can explicitly set E2E_SERVER_MODE=production to reuse its preceding build.
  if (process.env.E2E_SERVER_MODE === undefined) {
    process.env.E2E_SERVER_MODE = 'production';
    console.log('Building the bill report browser fixture...');
    runCliStep(process.execPath, [path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
      cwd: REPO_ROOT, env: { ...process.env, BANKING_NEXT_DIST_DIR: '.next-build', NEXT_TELEMETRY_DISABLED: '1' },
    });
  }
  provisionSchemaLadder({ repoRoot: REPO_ROOT, dbDir: path.join(REPO_ROOT, 'prisma'),
    dbFiles: ['bill-report-e2e.db', 'bill-report-e2e.db-wal', 'bill-report-e2e.db-shm', 'bill-report-e2e.db-journal'],
    env: process.env, rungs: [{ label: 'db push', args: ['prisma', 'db', 'push'] }] });
  const seed = cliCommand(resolveTsxBin(REPO_ROOT), ['tsx', 'prisma/seed.ts']);
  runCliStep(seed.command, seed.args, { cwd: REPO_ROOT, env: process.env });
  const { createDatabaseClient } = await import('../../lib/db/database');
  const fixture = createDatabaseClient();
  const profileName = '报告验收用户';
  try { await fixture.user.update({ where: { id: 'user_liming' }, data: { name: profileName } }); }
  finally { await fixture.$disconnect(); }
  server = await bootDevServer();
  const executable = resolveBrowserExecutable();
  assert.ok(executable, 'Chrome or Edge is required');
  browser = await launchBrowser(executable);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem('banking-agent:guide-dismissed', '1'));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${server.baseUrl}/bills/reports`, { waitUntil: 'domcontentloaded' });
  await waitForElementHydration(page, 'input[name="period"]');
  assert.equal(await page.getByRole('heading', { name: zh('pages.reports.title'), exact: true }).count(), 1);
  assert.equal(await page.getByLabel(zh('pages.reports.month')).inputValue(), '2026-09');
  assert.equal(await page.locator('[data-current-user]:visible p').innerText(), profileName);
  assert.equal(await page.locator('main svg [data-report-bucket]').count(), 5);
  const lightFlowColor = await page.locator('svg [data-report-bucket] rect').first().evaluate(element => getComputedStyle(element).fill);
  await page.screenshot({ path: path.join(evidenceDir, 'monthly-desktop.png'), fullPage: true });
  const monthly = await (await page.request.get(`${server.baseUrl}/api/bills/reports?month=2026-09`)).json();
  const bills = await (await page.request.get(`${server.baseUrl}/api/bills?month=2026-09`)).json();
  assert.equal(monthly.data.totals.spending, bills.data.analysis.total);
  assert.ok((await page.locator('main').innerText()).includes(formatCNY(monthly.data.totals.spending)));
  passed.push('monthly report renders exact seeded consumption');

  await page.getByText(zh('pages.reports.yearly'), { exact: true }).click();
  await page.getByLabel(zh('pages.reports.year')).fill('2026');
  await Promise.all([page.waitForURL('**/bills/reports?period=year&year=2026'), page.getByRole('button', { name: zh('pages.reports.view') }).click()]);
  assert.equal(await page.getByRole('heading', { name: '2026', exact: true }).count(), 1);
  const report = await (await page.request.get(`${server.baseUrl}/api/bills/reports?period=year&year=2026`)).json();
  assert.equal(report.data.trend.length, 12);
  assert.ok(report.data.totals.count > 0);
  await page.getByText(zh('pages.reports.trendDetails'), { exact: true }).click();
  assert.ok((await page.locator('main').innerText()).includes('2026-12'));
  await page.screenshot({ path: path.join(evidenceDir, 'annual-desktop.png'), fullPage: true });
  passed.push('annual form submits selected year and exposes twelve trend rows');

  const [analysisResponse] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/bills/reports/analysis') && response.request().method() === 'POST', { timeout: 65000 }),
    page.getByRole('button', { name: zh('pages.reports.generate'), exact: true }).click(),
  ]);
  const generated = await analysisResponse.json();
  assert.equal(analysisResponse.status(), 200, JSON.stringify(generated));
  assert.equal(generated.data.source, liveAnalysis ? 'model' : 'mock');
  await page.getByText(generated.data.blocks[0].explanation, { exact: true }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.getByRole('button', { name: zh('pages.reports.generate'), exact: true }).count(), 0);
  assert.ok((await page.locator('main').innerText()).includes(generated.data.blocks[0].explanation));
  passed.push(`${liveAnalysis ? 'live' : 'mock'} analysis is generated only on click and survives refresh`);

  for (const [label, extension] of [[zh('pages.reports.csv'), 'csv'], [zh('pages.reports.html'), 'html'], [zh('pages.reports.pdf'), 'pdf']] as const) {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: label }).click()]);
    assert.equal(download.suggestedFilename(), `bill-report-2026.${extension}`);
    await download.saveAs(path.join(evidenceDir, download.suggestedFilename()));
  }
  assert.equal(readFileSync(path.join(evidenceDir, 'bill-report-2026.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.ok(readFileSync(path.join(evidenceDir, 'bill-report-2026.html'), 'utf8').includes(generated.data.blocks[0].explanation));
  passed.push('CSV, chart-rich HTML and direct PDF downloads match the selected annual period and analysis');

  const preview = await context.newPage();
  await preview.goto(pathToFileURL(path.join(evidenceDir, 'bill-report-2026.html')).href);
  assert.equal(await preview.locator('h1').innerText(), `2026 · ${zh('pages.reports.yearly')}`);
  assert.equal(await preview.locator('.chart table tbody tr').count(), 12);
  assert.equal(await preview.locator('.ledger tbody tr').count(), report.data.totals.count);
  assert.equal(await preview.locator('svg').count(), 2);
  await preview.emulateMedia({ media: 'print' });
  await preview.screenshot({ path: path.join(evidenceDir, 'annual-print.png') });
  await preview.close();
  passed.push('downloaded HTML renders all annual rows with print styles');

  await page.getByText(zh('pages.reports.monthly'), { exact: true }).click();
  await page.getByLabel(zh('pages.reports.month')).fill('2040-02');
  await Promise.all([page.waitForURL('**/bills/reports?period=month&month=2040-02'), page.getByRole('button', { name: zh('pages.reports.view') }).click()]);
  assert.equal(await page.getByRole('status').innerText(), zh('pages.reports.empty'));
  passed.push('empty period stays usable without invented comparisons');

  await page.goto(`${server.baseUrl}/bills/reports?period=month&month=2026-13`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('main').getByRole('alert').innerText(), zh('pages.reports.invalid'));
  assert.equal(await page.getByRole('link', { name: zh('pages.reports.csv') }).count(), 0);
  passed.push('invalid query shows a recoverable form and no misleading export');

  // Insert a larger ledger through the dedicated fixture DB, then exercise real page navigation.
  const db = createDatabaseClient();
  try {
    if (liveAnalysis) {
      const record = await db.billReportAnalysis.findFirstOrThrow({ where: { status: 'completed' } });
      assert.equal(record.httpStatus, 200);
      assert.ok(JSON.parse(record.budgetJson!).requests >= 1);
    }
    await db.transaction.createMany({ data: Array.from({ length: 121 }, (_, index) => ({ userId: 'user_liming', accountId: 'acct_checking',
      occurredAt: new Date(Date.parse('2030-01-01T00:00:00Z') + index * 60000), direction: 'DEBIT', amountMinor: -1n, category: '餐饮', merchant: `Report ${index}` })) });
  } finally { await db.$disconnect(); }
  await page.goto(`${server.baseUrl}/bills/reports?month=2030-01`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('main table').last().locator('tbody tr').count(), 50);
  await page.getByRole('link', { name: zh('pages.reports.nextPage'), exact: true }).click();
  await page.waitForURL('**/bills/reports?period=month&month=2030-01&page=2');
  await page.getByRole('link', { name: zh('pages.reports.nextPage'), exact: true }).click();
  await page.waitForURL('**/bills/reports?period=month&month=2030-01&page=3');
  assert.equal(await page.locator('main table').last().locator('tbody tr').count(), 21);
  const csv = await (await page.request.get(`${server.baseUrl}/api/bills/reports?month=2030-01&format=csv`)).text();
  assert.equal(csv.trim().split('\r\n').length, 122);
  passed.push('ledger pagination and full export preserve all 121 rows');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${server.baseUrl}/bills/reports?month=2026-09`, { waitUntil: 'domcontentloaded' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'mobile document must not overflow horizontally');
  await page.screenshot({ path: path.join(evidenceDir, 'monthly-mobile.png'), fullPage: true });
  passed.push('mobile form and report fit a 390px viewport');
  await page.getByRole('button', { name: zh('app.openNavigation'), exact: true }).click();
  assert.equal(await page.locator('[data-current-user]:visible p').innerText(), profileName);
  await page.screenshot({ path: path.join(evidenceDir, 'mobile-profile.png') });
  await page.getByRole('button', { name: zh('app.closeNavigation'), exact: true }).click();
  passed.push('desktop and mobile navigation show the server-provided current user name');

  await context.addCookies([{ name: 'banking_locale', value: 'en', url: server.baseUrl }]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.getByRole('heading', { name: en('pages.reports.title'), exact: true }).count(), 1);
  assert.ok((await page.getByRole('link', { name: en('pages.reports.csv') }).getAttribute('href'))?.includes('locale=en'));
  passed.push('English UI and export locale remain consistent without browser errors');
  await context.addCookies([{ name: THEME_COOKIE, value: 'dark', url: server.baseUrl }]);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForElementHydration(page, 'input[name="period"]');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  const darkFlowColor = await page.locator('svg [data-report-bucket] rect').first().evaluate(element => getComputedStyle(element).fill);
  assert.notEqual(darkFlowColor, lightFlowColor, 'report series colors must adapt to the dark theme');
  await page.getByRole('radio').first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio').last().isChecked(), true);
  assert.equal(await page.getByLabel(en('pages.reports.year')).count(), 1);
  await page.screenshot({ path: path.join(evidenceDir, 'report-dark.png') });
  assert.deepEqual(errors, []);
  passed.push('dark theme and keyboard period selection remain usable');
  writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ passed }, null, 2));
  console.log(`PASS bill-reports: ${passed.length} browser scenarios`);
} catch (error) {
  console.error('FAIL bill-reports:', error);
  writeFileSync(path.join(evidenceDir, 'failure.txt'), `${String(error)}\n${server?.output() ?? ''}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.stop();
}
