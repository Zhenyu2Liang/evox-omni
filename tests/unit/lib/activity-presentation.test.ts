import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '@/lib/i18n/shared';
import type { ActivityRecord } from '@/lib/contracts/activity';
import { ActivityHistory } from '@/app/activity/ActivityHistory';

const mocks = vi.hoisted(() => ({
  enabled: false, list: vi.fn(), summary: vi.fn(), identity: vi.fn(), history: vi.fn(),
}));
vi.mock('@/lib/developer-mode/server', () => ({ getServerDeveloperMode: async () => mocks.enabled }));
vi.mock('@/lib/i18n/server', async () => {
  const { createTranslator: translator } = await import('@/lib/i18n/shared');
  return { getServerI18n: async () => ({ t: translator('zh-CN'), locale: 'zh-CN' }) };
});
vi.mock('@/app/api/_lib/session', () => ({ requireIdentity: mocks.identity }));
vi.mock('@/audit', () => ({ audit: { listAudit: mocks.list, getAuditSummary: mocks.summary }, listOperationHistory: mocks.history }));
import AuditPage from '@/app/audit/page';
import ActivityPage from '@/app/activity/page';

describe('operation history and developer audit rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.enabled = false;
    mocks.identity.mockResolvedValue({ userId: 'demo-user', sessionId: 'fixed-workspace' });
  });

  it.each(['zh-CN', 'en'] as const)('renders only closed business fields in %s', locale => {
    const entry: ActivityRecord & Record<string, unknown> = { id: 'private-action-id', timestamp: 1780000000000,
      type: 'card_freeze', status: 'completed', verification: 'passed', toolName: 'freeze_card',
      toolArgs: { cardId: 'internal-card-id' }, toolResult: 'raw-result-marker', userRequest: 'private-prompt',
      sessionId: 'private-session', riskLevel: 'RED' };
    const t = createTranslator(locale);
    const markup = renderToStaticMarkup(createElement(ActivityHistory, { entries: [entry], t }));
    expect(markup).toContain(t('pages.activity.type.card_freeze'));
    expect(markup).toContain(t('pages.activity.status.completed'));
    expect(markup).toContain(t('pages.activity.verification.passed'));
    for (const internal of ['private-action-id', 'freeze_card', 'internal-card-id', 'raw-result-marker', 'private-prompt', 'private-session', 'RED']) {
      expect(markup).not.toContain(internal);
    }
    expect(markup).not.toContain('<button');
  });

  it('blocks a direct audit page before identity and audit data are loaded', async () => {
    const markup = renderToStaticMarkup(await AuditPage());
    expect(markup).toContain(createTranslator('zh-CN')('app.developerRequired'));
    expect(markup).not.toContain('data-developer-audit');
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.summary).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'en'] as const)('shows an own-transaction acknowledgement as a business action in %s', locale => {
    const t = createTranslator(locale);
    const entry: ActivityRecord = { id: 'acknowledgement-id', timestamp: 1780000000000,
      type: 'transaction_acknowledgement', status: 'completed', verification: 'not_required' };
    const markup = renderToStaticMarkup(createElement(ActivityHistory, { entries: [entry], t }));
    expect(markup).toContain(t('pages.activity.type.transaction_acknowledgement'));
    expect(markup).toContain(t('pages.activity.status.completed'));
    expect(markup).not.toContain('acknowledge_transaction');
    expect(markup).not.toContain('acknowledgement-id');
  });

  it('reads and displays technical evidence only after the server developer gate', async () => {
    mocks.enabled = true;
    mocks.list.mockResolvedValue([{ id: 'audit-id', timestamp: 1780000000000, sessionId: 'fixed-workspace', userId: 'demo-user',
      userRequest: 'Source request', toolName: 'freeze_card', riskLevel: 'RED', confirmationRequired: true, confirmed: true,
      mfaRequired: true, mfaResult: 'success', toolArgs: { cardId: 'raw-card-marker' }, toolResult: { success: true }, status: 'success' }]);
    mocks.summary.mockResolvedValue({ total: 1, byRisk: { RED: 1 }, byStatus: { success: 1 } });
    const markup = renderToStaticMarkup(await AuditPage());
    expect(markup).toContain('data-developer-audit');
    expect(markup).toContain('freeze_card');
    expect(markup).toContain('raw-card-marker');
    expect(mocks.list).toHaveBeenCalledWith({ userId: 'demo-user', sessionId: 'fixed-workspace' });
  });

  it('loads the public server page exclusively through the owner-scoped business projection', async () => {
    mocks.history.mockResolvedValue([]);
    const markup = renderToStaticMarkup(await ActivityPage());
    expect(markup).toContain(createTranslator('zh-CN')('pages.activity.emptyTitle'));
    expect(mocks.history).toHaveBeenCalledWith({ userId: 'demo-user', sessionId: 'fixed-workspace' });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
