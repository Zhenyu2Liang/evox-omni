import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { NextRequest } from 'next/server';
import { banking } from '@/banking-sdk';
import * as providers from '@/agent/providers';
import { generateBillReportAnalysis, readBillReportAnalysis, reportCommentarySchema } from '@/agent/bill-report-analysis';
import { claimReportAnalysis, updateReportAnalysis } from '@/lib/db/repositories/bill-report-analysis';
import { POST } from '@/app/api/bills/reports/analysis/route';
import { GET } from '@/app/api/bills/reports/route';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';

useFreshDatabase();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const valid = { blocks: [{ factId: 'cashflow' as const, explanation: 'Cash movement should be reviewed alongside recurring spending.' }],
  suggestions: ['Review discretionary purchases before setting the next spending budget.'] };
function provider(text = JSON.stringify(valid), stopReason: 'stop' | 'length' = 'stop') {
  vi.stubEnv('LLM_MODE', 'live');
  const reg = fauxProvider(), collection = createModels();
  collection.setProvider(reg.provider); reg.setResponses([{ ...fauxAssistantMessage(text), stopReason }]);
  let captured = '';
  const streamFn = vi.fn(async (...args: Parameters<ReturnType<typeof providers.resolveProvider>['streamFn']>) => {
    const record = await getTestPrisma().billReportAnalysis.findFirstOrThrow();
    expect(JSON.parse(record.budgetJson!).requests).toBe(1);
    captured = JSON.stringify(args[1]);
    return collection.streamSimple(args[0], args[1], args[2]);
  });
  vi.spyOn(providers, 'resolveProvider').mockReturnValue({ model: reg.getModel(), streamFn });
  return { streamFn, context: () => captured };
}

describe('explicit report model analysis', () => {
  it('reserves a persisted budget before the provider, sends summary facts only, and reuses the saved result', async () => {
    const runtime = provider(), report = await banking.report.getBillReport(DEMO_USER_ID);
    const first = await generateBillReportAnalysis(DEMO_USER_ID, report, 'en');
    expect(first.source).toBe('model');
    expect(first.blocks).toEqual(valid.blocks);
    expect(await generateBillReportAnalysis(DEMO_USER_ID, report, 'en')).toEqual(first);
    expect(runtime.streamFn).toHaveBeenCalledTimes(1);
    expect(runtime.context()).not.toContain('Apple Store');
    expect(runtime.context()).not.toContain('acct_checking');
    expect(runtime.context()).not.toContain('user_liming');
    expect((await getTestPrisma().billReportAnalysis.findFirstOrThrow()).status).toBe('completed');
  });
  it('invalidates analysis when ledger facts, locale, or provider mode change', async () => {
    const runtime = provider(), report = await banking.report.getBillReport(DEMO_USER_ID);
    await generateBillReportAnalysis(DEMO_USER_ID, report, 'en');
    expect(await readBillReportAnalysis(DEMO_USER_ID, report, 'zh-CN')).toBeNull();
    report.transactions[0].isAnomaly = !report.transactions[0].isAnomaly;
    expect(await readBillReportAnalysis(DEMO_USER_ID, report, 'en')).toBeNull();
    vi.stubEnv('LLM_MODE', 'mock');
    expect(await readBillReportAnalysis(DEMO_USER_ID, await banking.report.getBillReport(DEMO_USER_ID), 'en')).toBeNull();
    expect(runtime.streamFn).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent generation into one paid provider call', async () => {
    const runtime = provider(), report = await banking.report.getBillReport(DEMO_USER_ID);
    const results = await Promise.allSettled([generateBillReportAnalysis(DEMO_USER_ID, report, 'en'), generateBillReportAnalysis(DEMO_USER_ID, report, 'en')]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    for (const result of results) if (result.status === 'rejected') expect(result.reason.code).toBe('CONFLICT');
    expect(runtime.streamFn).toHaveBeenCalledTimes(1);
    expect(await getTestPrisma().billReportAnalysis.count({ where: { status: 'completed' } })).toBe(1);
  });
  it('keeps the report-specific budget caps when environment settings are invalid', async () => {
    provider();
    vi.stubEnv('AGENT_MAX_MODEL_REQUESTS', '-1'); vi.stubEnv('AGENT_MAX_MODEL_TOKENS', '-1'); vi.stubEnv('AGENT_MAX_TURN_MS', '-1');
    await generateBillReportAnalysis(DEMO_USER_ID, await banking.report.getBillReport(DEMO_USER_ID), 'en');
    const record = await getTestPrisma().billReportAnalysis.findFirstOrThrow();
    expect(JSON.parse(record.budgetJson!).limits).toEqual({ maxRequests: 2, maxTokens: 16000, maxDurationMs: 45000 });
  });
  it('refuses a token-truncated response even when its JSON happens to be complete', async () => {
    provider(JSON.stringify(valid), 'length');
    await expect(generateBillReportAnalysis(DEMO_USER_ID, await banking.report.getBillReport(DEMO_USER_ID), 'en')).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect((await getTestPrisma().billReportAnalysis.findFirstOrThrow()).status).toBe('failed');
  });
  it.each([
    'not JSON', JSON.stringify({ ...valid, extra: 'unknown' }),
    JSON.stringify({ ...valid, blocks: [{ factId: 'cashflow', explanation: 'You saved 99999 yuan.' }] }),
    JSON.stringify({ ...valid, blocks: [valid.blocks[0], valid.blocks[0]] }),
    JSON.stringify({ ...valid, blocks: [{ factId: 'cashflow', explanation: '已成功冻结你的银行卡。' }] }),
  ])('rejects incomplete or unsupported model claims without saving them: %s', async text => {
    provider(text);
    const report = await banking.report.getBillReport(DEMO_USER_ID);
    const before = await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    await expect(generateBillReportAnalysis(DEMO_USER_ID, report, 'en')).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(await readBillReportAnalysis(DEMO_USER_ID, report, 'en')).toBeNull();
    const saved = await getTestPrisma().billReportAnalysis.findFirstOrThrow();
    expect(saved.status).toBe('failed');
    expect(JSON.parse(saved.budgetJson!).requests).toBe(1);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: before.id } })).balanceMinor).toBe(before.balanceMinor);
  });
  it('fences duplicate requests, expired attempts and foreign owners', async () => {
    const first = await claimReportAnalysis('lease-test', DEMO_USER_ID, 'snapshot');
    expect(first).toBeTruthy();
    expect(await claimReportAnalysis('lease-test', DEMO_USER_ID, 'snapshot')).toBeNull();
    await getTestPrisma().billReportAnalysis.update({ where: { id: 'lease-test' }, data: { leaseExpiresAt: new Date(0) } });
    const second = await claimReportAnalysis('lease-test', DEMO_USER_ID, 'snapshot');
    expect(second).not.toBe(first);
    await expect(updateReportAnalysis('lease-test', DEMO_USER_ID, first!, { status: 'completed' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(updateReportAnalysis('lease-test', 'foreign', second!, { status: 'completed' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await updateReportAnalysis('lease-test', DEMO_USER_ID, second!, { status: 'completed' });
  });
  it('labels offline results as simulated and automatically includes them in matching HTML exports', async () => {
    const report = await banking.report.getBillReport(DEMO_USER_ID);
    const result = await generateBillReportAnalysis(DEMO_USER_ID, report, 'zh-CN');
    expect(result.source).toBe('mock');
    expect(reportCommentarySchema.safeParse({ blocks: result.blocks, suggestions: result.suggestions }).success).toBe(true);
    const response = await GET(new NextRequest('http://localhost/api/bills/reports?month=2026-09&format=html'));
    expect(await response.text()).toContain(result.blocks[0].explanation);
  });
  it('refuses empty reports and cross-origin or forged requests before generation', async () => {
    const runtime = provider();
    await expect(generateBillReportAnalysis(DEMO_USER_ID, await banking.report.getBillReport(DEMO_USER_ID, { month: '2040-02' }), 'en')).rejects.toMatchObject({ code: 'VALIDATION' });
    for (const [body, origin, status] of [[{ query: {}, locale: 'en', userId: 'foreign' }, 'http://localhost', 400],
      [{ query: {}, locale: 'en' }, 'https://attacker.example', 403], [{ query: { period: 'year', month: '2026-09' }, locale: 'en' }, 'http://localhost', 400]] as const) {
      const response = await POST(new NextRequest('http://localhost/api/bills/reports/analysis', { method: 'POST',
        headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      expect(response.status).toBe(status);
    }
    expect(runtime.streamFn).not.toHaveBeenCalled();
    expect(await getTestPrisma().billReportAnalysis.count()).toBe(0);
  });
});
