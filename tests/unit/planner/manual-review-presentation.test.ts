import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlanCard } from '@/components/chat/cards/PlanCard';
import { ReconciliationCard } from '@/components/chat/cards/ReconciliationCard';
import { DeveloperModeContext } from '@/lib/developer-mode/DeveloperModeProvider';
import type { TaskPlan } from '@/lib/contracts/task';
import type { PendingActionSummary } from '@/lib/contracts/security';
import ManualPage from '@/app/manual/page';

function render(content: ReactElement, enabled: boolean) {
  return renderToStaticMarkup(createElement(DeveloperModeContext.Provider, {
    value: { enabled, pending: false, setEnabled: () => undefined }, children: content,
  }));
}

describe('demo operator reconciliation presentation', () => {
  const plan: TaskPlan = { id: 'failed-plan', sessionId: 'demo-session', goal: 'Check balance', status: 'failed',
    nodes: [], results: [], createdAt: 1, updatedAt: 2 };
  const action: PendingActionSummary = { actionId: 'uncertain-action', toolName: 'freeze_card',
    title: 'Freeze card', fields: [], tier: 'RED', requiresMfa: true };

  it.each([false, true])('limits failed-plan reconciliation links to developer mode (%s)', enabled => {
    expect(render(createElement(PlanCard, { plan }), enabled).includes('href="/manual"')).toBe(enabled);
  });

  it.each([false, true])('limits uncertain-action reconciliation links to developer mode (%s)', enabled => {
    expect(render(createElement(ReconciliationCard, { action, attention: 'reconciliation' }), enabled).includes('href="/manual"')).toBe(enabled);
  });

  it('does not render the operator inbox when developer mode is disabled', () => {
    const markup = render(createElement(ManualPage), false);
    expect(markup).not.toContain('data-review-id');
    expect(markup).not.toContain('href="/audit"');
    expect(markup).toContain('type="button"');
  });
});
