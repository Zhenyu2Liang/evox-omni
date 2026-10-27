/**
 * tests/integration/security-deny-redaction.test.ts — a REAL gateway refusal never leaks its internal
 * payload, and the lock's audit rows are complete and marker-free.
 *
 * PART 1 (redaction): the owner circuit breaker is tripped by three WRONG MFA codes submitted through
 * `securityGateway.authorizeAction` (via `helpers/scenario.ts#verifyAction`) on a genuinely parked RED
 * action. A FURTHER write is then attempted with a production Pi agent (`helpers/faux-agent.ts`, whose
 * `beforeToolCall` calls `securityGateway.handleToolCall`). The gateway refuses it with the opaque
 * prefixed block reason (`` __SECURITY_BLOCK__{"decisionKind":"deny",...} ``) and `agent/turns/events.ts`
 * — the SAME projector `agent/run-turn.ts` uses — turns the resulting Pi tool event into the public
 * `security_event { kind: 'locked' }` frame. The whole projected payload (events / cards / tool events /
 * prose) MUST NOT carry the internal markers; the frame itself is TYPED-ONLY.
 *
 * PART 2 (audit): the three wrong codes must persist exactly 3 `MFA_FAILURE` rows (numeric `attempts`
 * 1→2→3, `attemptsLeft` 2→1→0, `maxAttempts` 3) and exactly 1 `CIRCUIT_BREAKER_TRIPPED` (severity
 * `high`), with `message`/`detail` marker-free, and the `PendingAction`/`MfaChallenge` rows `locked`.
 *
 * Why the exotic wiring: `helpers/scenario.ts#decideAndContinue` returns ONLY `{ text }` (empty
 * events/cards) whenever a gateway outcome is not ok, so it cannot carry the deny projection. The
 * frame here is still produced entirely by PRODUCTION code — the real gateway mints the block reason,
 * the real Pi agent loop emits the blocked tool result, and `agent/turns/events.ts#createEventHandler`
 * projects it — never by a literal in this spec.
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { AgentStreamEvent, ChatCard, ToolEventView } from '@/lib/contracts/agent';
import { demoNow } from '@/lib/clock';
import { safeParse } from '@/lib/json';
import { createTurnBuffer } from '@/agent/turns/buffer';
import { createEventHandler } from '@/agent/turns/events';
import { security } from '@/security';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import { newSessionId, runTurn, verifyAction } from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';

/** A deliberately WRONG 6-digit code (never the demo code `MFA_CODE`). */
const WRONG_CODE = '000000';

/** The canonical RED action: `subscribe_investment` is STATICALLY RED → requires MFA. */
const RED_TOOL = 'subscribe_investment';
const RED_ARGS = { productId: 'prod_wenjiana', amount: '5000' };

/** Fate of a refused write: plain prose, so the projector publishes it verbatim. */
const NARRATION = '该操作已被安全策略拒绝。';

/** Substrings that must never reach a public payload (internal payload shape / bad stringification). */
const INTERNAL_MARKERS = ['__SECURITY_BLOCK__', 'decisionKind', '[object Object]'] as const;
/** A leaked stack frame (`\n    at fn (file:line:col)`). */
const STACK_FRAME = /\n\s+at\s/;

const gateway = security.gateway.securityGateway;

/** Assert a serialized payload carries NONE of the internal markers. */
function expectMarkerFree(serialized: string, where: string): void {
  for (const marker of INTERNAL_MARKERS) {
    expect(serialized.includes(marker), `${where} leaked the internal marker ${marker}`).toBe(false);
  }
  expect(STACK_FRAME.test(serialized), `${where} leaked a stack frame`).toBe(false);
}

/** Narrow the public stream to its `security_event` frames. */
function securityEvents(events: readonly AgentStreamEvent[]): Extract<AgentStreamEvent, { type: 'security_event' }>[] {
  return events.filter((event): event is Extract<AgentStreamEvent, { type: 'security_event' }> =>
    event.type === 'security_event');
}

/**
 * Drive ONE RED tool call through the full pipeline and submit the WRONG code three times, tripping
 * the owner circuit breaker (3 consecutive failures) and locking the parked action.
 * Throws (rather than silently passing) when the gateway did NOT gate the call.
 */
async function lockOwnerSession(): Promise<{ sessionId: string; agent: Agent; actionId: string }> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool(RED_TOOL, RED_ARGS), final('请完成安全验证。')],
  });
  const first = await runTurn({ sessionId, message: '买5000元稳健理财A', agent });

  const actionId = first.mfa?.actionId;
  if (actionId === undefined) {
    throw new Error(`expected a RED mfa_required outcome for ${RED_TOOL}, got cards: ${JSON.stringify(first.cards)}`);
  }

  // `verifyAction` → `securityGateway.authorizeAction` → `mfa.verify` → `recordFailure` (NOT
  // `security/mfa.ts#verify` directly, which would lock only the challenge and not the action).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await verifyAction(agent, actionId, WRONG_CODE);
  }
  return { sessionId, agent, actionId };
}

/** What one projected turn exposes: the production public stream plus its card/tool/prose surface. */
interface ProjectedAttempt {
  events: AgentStreamEvent[];
  cards: ChatCard[];
  toolEvents: ToolEventView[];
  text: string;
}

/**
 * Attempt ANOTHER RED write on the now-locked session with a real Pi agent and project the turn
 * through the PRODUCTION projector (`agent/turns/events.ts`), the same module `run-turn` installs.
 */
async function attemptRedWhileLocked(sessionId: string): Promise<ProjectedAttempt> {
  const agent = buildFauxAgent({
    sessionId,
    script: [tool(RED_TOOL, RED_ARGS), final(NARRATION)],
  });
  const buffer = createTurnBuffer('再买5000元稳健理财A');
  const unsubscribe = agent.subscribe(createEventHandler(buffer, () => demoNow()));
  try {
    await agent.prompt('再买5000元稳健理财A');
  } finally {
    unsubscribe();
  }

  const messages = [...buffer.assistants, ...buffer.toolMessages.values()];
  return {
    events: buffer.events,
    cards: messages.flatMap(message => message.cards ?? []),
    toolEvents: messages.flatMap(message => message.toolEvents ?? []),
    text: buffer.assistants.filter(message => message.role === 'assistant')
      .map(message => message.content).join('\n'),
  };
}

describe('security deny redaction', () => {
  useFreshDatabase();

  it('a genuine gateway deny projects a typed-only locked frame and leaks no internal marker', async () => {
    const { sessionId } = await lockOwnerSession();

    // The RAW gateway refusal is the prefixed internal payload — this is what the blocked tool result
    // carries to the projector, so the marker-free assertions below are not vacuous.
    const raw = await gateway.handleToolCall({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: RED_TOOL,
      args: RED_ARGS,
      userRequest: '再买5000元稳健理财A',
    });
    expect(raw.evaluation.blocked).toBe(true);
    expect(raw.decision.kind).toBe('deny');
    expect(raw.action).toBeUndefined();
    const blockReason = raw.blockReason ?? '';
    expect(blockReason.startsWith(security.gateway.BLOCK_REASON_PREFIX)).toBe(true);
    expect(blockReason).toContain('decisionKind');
    expect(blockReason).toContain('CIRCUIT_OPEN');

    // The SAME refusal, produced by the real gateway inside the agent's `beforeToolCall`, is projected
    // by production presentation code into the public turn.
    const attempt = await attemptRedWhileLocked(sessionId);

    // The refusal frame is TYPED-ONLY: `kind` + structured `code`/`reason`, no payload, no prose.
    const frames = securityEvents(attempt.events);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.kind).toBe('locked');
    expect(frame.code).toBe('CIRCUIT_OPEN');
    expect(frame.reason).toBe('circuit_open');
    expect(frame.message).toBeUndefined();
    expect(frame.actionId).toBeUndefined();
    expect(Object.keys(frame).sort()).toEqual(['code', 'kind', 'reason', 'type']);

    // The tool timeline row carries typed facts only — never the raw block reason as a summary.
    const blocked = attempt.toolEvents.filter(event => event.status === 'blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].toolName).toBe(RED_TOOL);
    expect(blocked[0].errorCode).toBe('CIRCUIT_OPEN');
    expect(blocked[0].summary).toBeUndefined();
    expect(blocked[0].debugDetail).toBeUndefined();

    // Whole-payload redaction: NOTHING public may carry the internal shape.
    expectMarkerFree(JSON.stringify(attempt.events), 'events');
    expectMarkerFree(JSON.stringify(attempt.cards), 'cards');
    expectMarkerFree(JSON.stringify(attempt.toolEvents), 'toolEvents');
    expectMarkerFree(attempt.text, 'text');
    // The refusal is still a real, non-empty server-side narration.
    expect(attempt.text.trim().length).toBeGreaterThan(0);
  });

  it('the lock audit rows are complete and marker-free', async () => {
    const { sessionId, actionId } = await lockOwnerSession();
    const prisma = getTestPrisma();

    // Three wrong codes → exactly three MFA_FAILURE rows, each a COMPLETE audit record.
    const failures = await prisma.securityEvent.findMany({
      where: { sessionId, kind: 'MFA_FAILURE' },
    });
    expect(failures).toHaveLength(3);

    const details = failures.map(row => {
      expect(row.message.trim().length).toBeGreaterThan(0);
      expectMarkerFree(row.message, 'MFA_FAILURE.message');
      expect(row.detail).toBeTypeOf('string');
      expectMarkerFree(row.detail ?? '', 'MFA_FAILURE.detail');
      return safeParse<Record<string, unknown>>(row.detail ?? '', {});
    });

    // Numeric counters, ordered by attempt — no prose, no placeholders, no missing field.
    const ordered = [...details].sort((left, right) => Number(left.attempts) - Number(right.attempts));
    expect(ordered.map(detail => detail.attempts)).toEqual([1, 2, 3]);
    expect(ordered.map(detail => detail.attemptsLeft)).toEqual([2, 1, 0]);
    expect(ordered.map(detail => detail.maxAttempts)).toEqual([3, 3, 3]);
    expect(ordered.map(detail => detail.locked)).toEqual([false, false, true]);
    expect(ordered.map(detail => detail.result)).toEqual(['attempt_counted', 'attempt_counted', 'session_locked']);
    for (const detail of ordered) {
      expect(typeof detail.attempts).toBe('number');
      expect(typeof detail.attemptsLeft).toBe('number');
      expect(typeof detail.maxAttempts).toBe('number');
      expect(detail.actionId).toBe(actionId);
      expect(detail.decision).toBe('reject_code');
    }

    // Exactly ONE trip event for the owner, severity `high`, carrying the failure count/max.
    const trips = await prisma.securityEvent.findMany({
      where: { sessionId, kind: 'CIRCUIT_BREAKER_TRIPPED' },
    });
    expect(trips).toHaveLength(1);
    const trip = trips[0];
    expect(trip.severity).toBe('high');
    expect(trip.message.trim().length).toBeGreaterThan(0);
    expectMarkerFree(trip.message, 'CIRCUIT_BREAKER_TRIPPED.message');
    expect(trip.detail).toBeTypeOf('string');
    expectMarkerFree(trip.detail ?? '', 'CIRCUIT_BREAKER_TRIPPED.detail');
    const tripDetail = safeParse<Record<string, unknown>>(trip.detail ?? '', {});
    expect(typeof tripDetail.failures).toBe('number');
    expect(Number(tripDetail.failures)).toBeGreaterThanOrEqual(3);
    expect(tripDetail.max).toBe(3);
    expect(tripDetail.result).toBe('session_locked');

    // Every audit row of this lock is marker-free — no internal payload reached the store.
    const allRows = await prisma.securityEvent.findMany({ where: { sessionId } });
    for (const row of allRows) {
      expectMarkerFree(row.message, `${row.kind}.message`);
      expectMarkerFree(row.detail ?? '', `${row.kind}.detail`);
    }

    // The refusal is durable on BOTH rows (never re-surfaced as a pending decision).
    const pending = await prisma.pendingAction.findUnique({ where: { id: actionId } });
    expect(pending?.status).toBe('locked');
    const challenge = await prisma.mfaChallenge.findUnique({ where: { actionId } });
    expect(challenge?.status).toBe('locked');
    expect(challenge?.attempts).toBe(3);
    expect(challenge?.maxAttempts).toBe(3);
  });
});
