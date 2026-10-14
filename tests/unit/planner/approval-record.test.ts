import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardRenderer } from '@/components/chat/cards/CardRenderer';
import { ApprovalRequest } from '@/components/chat/ApprovalRequest';
import type { PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import { createTranslator } from '@/lib/i18n/shared';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';

const t = createTranslator('zh-CN');
const summary: PendingActionSummary = { actionId: 'read-action', title: 'Read active subscriptions.',
  toolName: 'list_subscriptions', tier: 'YELLOW', requiresMfa: false, fields: [{ label: 'Operation', value: 'Read active subscriptions.' }] };

describe('authorization requests and historical records', () => {
  it('dismisses accepted permission before execution finishes and rejects stale request frames', () => {
    const waiting = reduceAgentEvents(initialChatUIState({ messages: [{ id: 'owner', role: 'tool', timestamp: 0,
      content: '', cards: [{ type: 'confirmation', action: summary }] }] }), [
      { type: 'confirmation_required', actionId: 'read-action', action: summary },
    ]);
    const accepted = reduceAgentEvents(waiting, [{ type: 'action_settled', actionId: 'read-action', status: 'confirmed' },
      { type: 'confirmation_required', actionId: 'read-action', action: summary }]);
    expect(accepted.pendingAction).toBeUndefined();
    expect(accepted.messages[0].cards?.[0]).toMatchObject({ action: { status: 'confirmed' } });
    const completed = reduceAgentEvents(accepted, [{ type: 'action_settled', actionId: 'read-action', status: 'executed' },
      { type: 'action_settled', actionId: 'read-action', status: 'confirmed' }]);
    expect(completed.messages[0].cards?.[0]).toMatchObject({ action: { status: 'executed' } });
  });
  it.each<PendingActionStatus>(['pending', 'confirmed', 'executed', 'failed', 'cancelled', 'locked', 'needs_reconciliation'])
    ('renders %s history without actionable controls or a code field', status => {
      const markup = renderToStaticMarkup(createElement(CardRenderer, { card: {
        type: 'confirmation', action: { ...summary, status } as PendingActionSummary,
      }, action: { actionId: 'read-action', onConfirm: () => undefined, onCancel: () => undefined } }));
      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).toContain('data-approval-stage="previous" data-stage-status="pending"');
      expect(markup).toContain(`data-approval-stage="current" data-stage-status="${status}"`);
      expect(markup).not.toContain('<button');
      expect(markup).not.toContain('<input');
      if (status !== 'executed') expect(markup).not.toContain(t('chat.approval.status.executed'));
    });

  it('keeps MFA history verification-specific and never displays its hint as a new request', () => {
    const markup = renderToStaticMarkup(createElement(CardRenderer, { card: { type: 'mfa', actionId: 'freeze-action',
      action: { ...summary, actionId: 'freeze-action', requiresMfa: true, tier: 'RED' }, status: 'executed', hint: 'PRIVATE_CHALLENGE_HINT' } }));
    expect(markup).toContain('data-approval-stage="previous" data-stage-status="awaiting_mfa"');
    expect(markup).toContain('data-stage-status="executed"');
    expect(markup).not.toContain('PRIVATE_CHALLENGE_HINT');
    expect(markup).not.toContain('<input');
  });

  it('renders active confirmation separately with immutable amount and operation details', () => {
    const markup = renderToStaticMarkup(createElement(ApprovalRequest, {
      pending: { kind: 'confirmation', actionId: 'read-action', summary: { ...summary, amount: '500.50' } },
      action: { onConfirm: () => undefined, onCancel: () => undefined },
    }));
    expect(markup).toContain('data-approval-request="true"');
    expect(markup).toContain('data-kind="confirmation"');
    expect(markup).toContain('500.50');
    expect(markup).toContain(t('cards.confirm'));
    expect(markup).toContain(t('cards.cancel'));
    expect(markup).not.toContain('data-approval-history');
  });
});
