import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({
  listTransactions: vi.fn(), analyzeSpending: vi.fn(), searchContacts: vi.fn(),
  getBalance: vi.fn(), getDashboardSummary: vi.fn(), searchConversationHistory: vi.fn(), detectAnomaly: vi.fn(),
}));
vi.mock('@/banking-sdk', () => ({ banking: {
  transaction: { listTransactions: reads.listTransactions, analyzeSpending: reads.analyzeSpending, detectAnomaly: reads.detectAnomaly },
  contact: { searchContacts: reads.searchContacts }, account: { getBalance: reads.getBalance },
  dashboard: { getDashboardSummary: reads.getDashboardSummary },
} }));
vi.mock('@/agent/conversation-history-search', () => ({ searchConversationHistory: reads.searchConversationHistory }));

import { createDetectAnomalyTool, createGetTransactionsTool, runGetTransactions } from '@/agent/tools/transaction';
import { createAnalyzeSpendingTool, runAnalyzeSpending } from '@/agent/tools/analysis';
import { createSearchContactTool, runSearchContact } from '@/agent/tools/contact';
import { createGetBalanceTool, runGetBalance } from '@/agent/tools/account';
import { createGetDashboardSummaryTool, runGetDashboardSummary } from '@/agent/tools/dashboard';
import { createSearchConversationHistoryTool, runSearchConversationHistory } from '@/agent/tools/conversation-history';
import { AppError } from '@/lib/errors';

describe('read tool boundaries', () => {
  beforeEach(() => vi.resetAllMocks());

  it('rejects a malformed transaction filter instead of dropping it', async () => {
    expect(await runGetTransactions('owner', { from: 'yesterday' })).toMatchObject({ ok: false, errorCode: 'VALIDATION' });
    expect(reads.listTransactions).not.toHaveBeenCalled();
  });

  it('bounds model transaction reads and preserves explicit filters', async () => {
    reads.listTransactions.mockResolvedValue([]);
    await runGetTransactions('owner', { from: 0, to: 10 });
    expect(reads.listTransactions).toHaveBeenCalledWith('owner', { from: 0, to: 10, limit: 50 });
  });

  it('rejects malformed optional month input instead of querying the current month', async () => {
    for (const month of ['', 202609, '2026-13']) {
      expect(await runAnalyzeSpending('owner', { month })).toMatchObject({ ok: false, errorCode: 'VALIDATION' });
    }
    expect(reads.analyzeSpending).not.toHaveBeenCalled();
  });

  it('requires explicit contact-search text instead of listing all contacts on an invalid value', async () => {
    expect(await runSearchContact('owner', { query: 3 })).toMatchObject({ ok: false, errorCode: 'VALIDATION' });
    expect(reads.searchContacts).not.toHaveBeenCalled();
  });

  it('does not convert archive query objects into strings or discard invalid pagination', async () => {
    expect(await runSearchConversationHistory('owner', { query: {}, limit: 1 }, 'session'))
      .toMatchObject({ ok: false, errorCode: 'VALIDATION' });
    expect(await runSearchConversationHistory('owner', { query: 'hello', limit: '1' }, 'session'))
      .toMatchObject({ ok: false, errorCode: 'VALIDATION' });
    expect(reads.searchConversationHistory).not.toHaveBeenCalled();
  });

  it('preserves typed backend failures for model-facing policy', async () => {
    reads.getBalance.mockRejectedValue(new AppError('NOT_FOUND', 'Account owner not found.'));
    reads.getDashboardSummary.mockRejectedValue(new AppError('SECURITY_DENIED', 'Read not permitted.'));
    expect(await runGetBalance('owner', {})).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
    expect(await runGetDashboardSummary('owner', {})).toMatchObject({ ok: false, errorCode: 'SECURITY_DENIED' });
  });

  it.each([
    ['balance', () => createGetBalanceTool('owner').execute('read-call', {})],
    ['transactions', () => createGetTransactionsTool('owner').execute('read-call', {})],
    ['anomalies', () => createDetectAnomalyTool('owner').execute('read-call', {})],
    ['analysis', () => createAnalyzeSpendingTool('owner').execute('read-call', { month: '2026-10' })],
    ['contacts', () => createSearchContactTool('owner').execute('read-call', { query: 'Alex' })],
    ['dashboard', () => createGetDashboardSummaryTool('owner').execute('read-call', {})],
    ['history', () => createSearchConversationHistoryTool('owner', 'session').execute('read-call', { query: 'hello' })],
  ] as const)('returns a native typed Pi error from the standalone %s factory', async (_name, execute) => {
    for (const read of Object.values(reads)) read.mockRejectedValue(new AppError('NOT_FOUND', 'Owned resource unavailable.'));
    const result = await execute();
    expect(result.isError).toBe(true);
    const content = result.content[0];
    expect(content.type).toBe('text');
    if (content.type !== 'text') throw new Error('Expected a model-visible error envelope.');
    expect(JSON.parse(content.text)).toMatchObject({ bankingError: {
      code: 'NOT_FOUND', message: 'Owned resource unavailable.', retryable: false,
    } });
  });

  it('sends exact structured financial data to Pi content rather than details alone', async () => {
    const balance = { totalAvailable: '90071992547409.01', currency: 'CNY', asOf: 1,
      accounts: [{ id: 'account-owned', userId: 'private-owner', name: 'Checking', type: 'CHECKING',
        numberMasked: '****8821', balance: '90071992547409.01', currency: 'CNY' }], sessionId: 'private-session' };
    reads.getBalance.mockResolvedValue(balance);
    const result = await createGetBalanceTool('owner').execute('read-call', {});
    expect(result.isError).not.toBe(true);
    const content = result.content[1];
    if (content.type !== 'text') throw new Error('Expected model-visible financial data.');
    const data = JSON.parse(content.text).data;
    expect(data.totalAvailable).toBe('90071992547409.01');
    expect(data.accounts[0].id).toBe('account-owned');
    expect(content.text).not.toContain('private-owner');
    expect(content.text).not.toContain('private-session');
    expect(result.details).toBe(balance);
  });

  it('preserves complete archived quotations and trusted search identity in the standalone factory', async () => {
    const text = `A signed amount -10.00 with original wording. ${'Complete archived text. '.repeat(1000)}`;
    reads.searchConversationHistory.mockResolvedValue({ matches: [{ messageId: 'historical-message', role: 'user', text, index: 0, timestamp: 1 }], hasMore: false });
    const result = await createSearchConversationHistoryTool('owner', 'session').execute('read-call', { query: '-10.00', limit: 1 });
    expect(reads.searchConversationHistory).toHaveBeenCalledWith({ userId: 'owner', sessionId: 'session', query: '-10.00', limit: 1, beforeIndex: undefined });
    const content = result.content[1];
    if (content.type !== 'text') throw new Error('Expected model-visible archive data.');
    expect(JSON.parse(content.text).data.matches[0].text).toBe(text);
  });
});
