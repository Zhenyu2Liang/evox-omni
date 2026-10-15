import { describe, expect, it } from 'vitest';
import { projectOperationHistory } from '@/audit/operation-history';
import type { OperationAuditRow } from '@/lib/db/repositories/auditLog';
import { AGENT_TOOL_NAMES, catalogEntry } from '@/lib/contracts/tool-catalog';

function event(overrides: Partial<OperationAuditRow> = {}): OperationAuditRow {
  return { id: 'event-1', timestamp: new Date('2026-10-14T12:00:00Z'), toolName: 'transfer_money',
    status: 'success', mfaRequired: true, mfaResult: 'success', toolResult: null, dedupeKey: null,
    ...overrides };
}

describe('public operation history projection', () => {
  it('exposes only domain facts and never raw execution evidence', () => {
    const record = projectOperationHistory(event({ toolResult: JSON.stringify({ ok: true,
      data: { password: 'secret', accountId: 'internal', amount: '200.37' } }), dedupeKey: 'exec:internal' }));
    expect(record).toEqual({ id: 'event-1', timestamp: Date.parse('2026-10-14T12:00:00Z'),
      type: 'transfer', status: 'completed', verification: 'passed' });
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it.each(['get_balance', 'list_subscriptions', 'submit_plan', 'reset_security', 'unknown_tool', '__proto__'])
  ('excludes diagnostic or unsupported operation %s', toolName => {
    expect(projectOperationHistory(event({ toolName }))).toBeUndefined();
  });

  it.each([
    ['manual_add_card', 'card_add'], ['manual_delete_card', 'card_delete'],
    ['add_contact', 'contact_add'], ['delete_contact', 'contact_delete'],
    ['acknowledge_transaction', 'transaction_acknowledgement'],
  ])('maps direct form operation %s into a public business type', (toolName, type) => {
    expect(projectOperationHistory(event({ toolName }))?.type).toBe(type);
  });

  it.each(AGENT_TOOL_NAMES.filter(name => catalogEntry(name)?.effect === 'write'))
  ('covers the enabled banking write %s', toolName => {
    expect(projectOperationHistory(event({ toolName }))).toBeDefined();
  });

  it.each([
    ['allowed', 'processing'], ['blocked', 'blocked'], ['waiting_confirmation', 'awaiting_confirmation'],
    ['waiting_verification', 'awaiting_verification'], ['success', 'completed'], ['failed', 'incomplete'],
    ['cancelled', 'cancelled'], ['locked', 'locked'],
  ])('maps %s without inventing a financial outcome', (status, expected) => {
    expect(projectOperationHistory(event({ status }))?.status).toBe(expected);
  });

  it.each([
    { status: 'needs_reconciliation' }, { outcome: 'unknown' }, { needsReconciliation: true },
  ])('preserves unknown outcomes as needing review', data => {
    expect(projectOperationHistory(event({ status: 'blocked', toolResult: JSON.stringify({ ok: false, data }) }))?.status)
      .toBe('needs_review');
  });

  it('recognizes the durable reconciliation event identity even when result narration is unstructured', () => {
    expect(projectOperationHistory(event({ status: 'blocked', dedupeKey: 'reconcile:action',
      toolResult: JSON.stringify({ ok: false, error: 'Missing evidence' }) }))?.status).toBe('needs_review');
  });

  it('does not interpret error prose or malformed payloads as proof of an unknown commit', () => {
    expect(projectOperationHistory(event({ status: 'failed', toolResult: JSON.stringify({ error: 'needs_reconciliation' }) }))?.status)
      .toBe('incomplete');
    expect(projectOperationHistory(event({ status: 'failed', toolResult: '{' }))?.status).toBe('incomplete');
    expect(projectOperationHistory(event({ status: '__proto__' }))?.status).toBe('incomplete');
  });

  it.each([
    [{ mfaRequired: false, mfaResult: null }, 'not_required'],
    [{ mfaResult: 'failed' }, 'failed'],
    [{ status: 'waiting_confirmation', mfaResult: null }, 'pending'],
    [{ status: 'waiting_verification', mfaResult: null }, 'pending'],
    [{ status: 'blocked', mfaResult: null }, 'unknown'],
  ] satisfies Array<[Partial<OperationAuditRow>, string]>)('distinguishes verification evidence %j', (overrides, expected) => {
    expect(projectOperationHistory(event(overrides))?.verification).toBe(expected);
  });
});
