/**
 * Unit: `agent/turns/events` — a locked session must surface a STRUCTURED `security_event`.
 *
 * The gateway refuses the call with an opaque `__SECURITY_BLOCK__…` payload. The turn adapter must
 * PARSE it (`parseBlockReason`) and publish typed fields (`kind` / `code` / `reason` / `actionId`),
 * never the raw payload: no marker, no JSON fragment, no stack-trace residue in the public stream
 * or in the projected tool view.
 *
 * Drives the REAL chain (faux agent → `securityGateway.handleToolCall` → turn adapter) through
 * `tests/helpers/scenario.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { recordFailure } from '@/security/circuit-breaker';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import type { AgentStreamEvent, ToolEventView } from '@/lib/contracts/agent';
import { buildFauxAgent } from '@/tests/helpers/faux-agent';
import { newSessionId, runTurn } from '@/tests/helpers/scenario';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { useFreshDatabase } from '@/tests/helpers/db';

vi.setConfig({ hookTimeout: 60_000 });

useFreshDatabase();

/** A RED transfer — blocked by the circuit breaker before any pending action is created. */
const RED_TOOL = 'transfer_money';
const RED_ARGS = { amount: '5000.00', contactId: 'contact_zhangwei' };

/** Trip the breaker for the demo user (the owner `runTurn`'s session resolves to). */
async function lockDemoUser(): Promise<void> {
  for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) await recordFailure(DEMO_USER_ID);
}

/** Assert a value carries none of the internal diagnostic residue. */
function expectClean(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  expect(text).not.toContain('__SECURITY_BLOCK__');
  expect(text).not.toContain('"decisionKind"');
  expect(text).not.toContain('[object Object]');
  expect(text).not.toMatch(/\n\s+at /);
  expect(text).not.toMatch(/\b(Type|Range|Reference)?Error:/);
}

describe('agent/turns/events · locked session security event', () => {
  beforeEach(async () => {
    await lockDemoUser();
  });

  it('publishes a structured security event instead of the internal block payload', async () => {
    const sessionId = newSessionId('locked');
    const agent = buildFauxAgent({ sessionId, script: [{ kind: 'tool', toolCall: { tool: RED_TOOL, args: RED_ARGS } }] });

    const result = await runTurn({ sessionId, message: '帮我转 5000 给张伟', agent });

    const securityEvents = result.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: 'security_event' }> => event.type === 'security_event',
    );
    expect(securityEvents).toHaveLength(1);

    const event = securityEvents[0]!;
    expect(event.kind).toBe('locked');
    expect(['CIRCUIT_OPEN', 'MFA_LOCKED']).toContain(event.code);
    expect(typeof event.reason).toBe('string');
    expect(event.reason).not.toBe('');
    expect(event.message).toBeUndefined();
    expectClean(event);

    // The blocked tool view carries the typed code (and renderable params when present) only.
    const toolEnd = result.events.find(
      (item): item is Extract<AgentStreamEvent, { type: 'tool_end' }> =>
        item.type === 'tool_end' && item.toolEvent.status === 'blocked',
    );
    expect(toolEnd).toBeDefined();
    const view: ToolEventView = toolEnd!.toolEvent;
    expect(['CIRCUIT_OPEN', 'MFA_LOCKED']).toContain(view.errorCode);
    expectClean(view.summary ?? '');
    expectClean(view);
    if (view.errorParams !== undefined) {
      expect(Object.keys(view.errorParams).every(key => ['count', 'attemptsLeft', 'attemptsUsed', 'maxAttempts'].includes(key))).toBe(true);
    }
  });

  it('keeps the public summary catalog-owned for the blocked view', async () => {
    const sessionId = newSessionId('locked');
    const agent = buildFauxAgent({ sessionId, script: [{ kind: 'tool', toolCall: { tool: RED_TOOL, args: RED_ARGS } }] });

    const result = await runTurn({ sessionId, message: '帮我转 5000 给张伟', agent });

    const blocked = result.toolEvents.filter(event => event.status === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    const { publicToolSummary } = await import('@/lib/tool-feedback');
    const { createTranslator } = await import('@/lib/i18n/shared');
    const t = createTranslator('zh-CN');
    const summary = publicToolSummary(blocked[0]!, t);
    expect(summary).toBeDefined();
    expectClean(summary ?? '');
    expect(summary).toBe(t('chat.error.securityLocked'));
  });
});
