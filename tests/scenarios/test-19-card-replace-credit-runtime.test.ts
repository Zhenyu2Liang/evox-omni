/**
 * Scenario 19 — "我的信用卡丢了，帮我补办一张新卡": 补办 CREDIT 卡在 PRODUCTION 运行时可达 (RED MFA).
 *
 * Pipeline (PRODUCTION runtime, only the MODEL is scripted — path A):
 *   user message → `@/agent#runTurn` (durable admission + `describe_turn` interpretation)
 *   → Pi Agent → `replace_card` → Security Gateway `beforeToolCall` → RED ⇒ BLOCKED, a `PendingAction`
 *   parks as `awaiting_mfa`, a `mfa_required` event is published → human submits the code through the
 *   production decision entry `@/agent#verifyAction` (the same function `app/api/actions/[id]/verify`
 *   reaches through `_lib/agent-bridge`) → gateway executes the ORIGINAL validated args → Banking SDK
 *   → audit.
 *
 * Why this spec exists: `test-18` asserts that card CAPABILITY GUIDANCE must not deny real capability;
 * this file proves the capability it must not deny is actually REACHABLE end-to-end from the production
 * entry for a LOST CREDIT card (not only for the DEBIT card of `test-13`, and not only through the raw
 * Pi harness of `tests/helpers/scenario.ts`). `replace_card` mints a new card only after verification,
 * the source card stays terminally LOST, and the audit records the RED/MFA success.
 *
 * Not duplicated here: DEBIT replacement (`test-13`), virtual-card application (`test-14`), the virtual
 * card family lifecycle + monthly allowance continuity across 补办 (`test-16`), and the server-owned
 * consumption booking-time guard (`test-17`).
 *
 * World: the shared seed holds exactly TWO ACTIVE cards for 李明 — `card_credit` (CREDIT, ****6688)
 * and `card_debit` (DEBIT, ****8821) — and NO lost card, so the LOST precondition is seeded through the
 * REAL SDK (`banking.card.reportLostCard`, allowed as test SETUP only). The only behaviour under test is
 * what the production runtime does, and every card/balance assertion is a DELTA against a snapshot.
 * Helpers: ../helpers/*.
 */
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from '@earendil-works/pi-ai';

import { runTurn, verifyAction } from '@/agent';
import type { ModelRuntime } from '@/agent/providers/types';
import { banking } from '@/banking-sdk';
import { MFA_CODE } from '@/lib/constants';
import type { AppConfig } from '@/lib/config';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { scriptedProvider } from '../helpers/scripted-provider';

useFreshDatabase();

const db = getTestPrisma;

/** The CREDIT card this spec replaces (the seed starts it ACTIVE, so it must first become LOST). */
const CARD = 'card_credit';
const USER_REQUEST = '我的信用卡丢了，帮我补办一张新卡';
/**
 * Scripted as the narration the model WOULD write after its call is blocked. The RED gate ends the turn
 * awaiting MFA, so this step is never requested (verified: `script.calls()` stays at declaration + blocked
 * call). It is kept in the script to prove the runtime does not spend an extra model request — and above
 * all does not let the model narrate the outcome of a mutation the human has not verified yet.
 */
const BLOCKED_NARRATION = '请完成验证以补办信用卡。';

/**
 * The write-continuation is gated on `llmMode === 'live'`; `tests/setup.ts` forces LLM_MODE=mock, so the
 * literal config is what the runtime actually uses here.
 */
const config: AppConfig = {
  llmMode: 'live',
  llmProvider: 'card-replace-runtime',
  llmModel: 'card-replace-runtime-model',
  demoUserId: DEMO_USER_ID,
};

/** A REAL gate is a persisted PendingAction surfaced by the gateway — never model prose. */
function hasGate(turn: Pick<ChatTurnResponse, 'events'>): boolean {
  return turn.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required');
}

/** The final assistant text of the turn (the grounded one the user sees). */
function finalContent(turn: Pick<ChatTurnResponse, 'events'>): string {
  return turn.events
    .flatMap(event => event.type === 'message_end' && event.message.role === 'assistant' ? [event.message.content] : [])
    .filter(Boolean)
    .at(-1) ?? '';
}

/** One controlled-tool call step (the `describe_turn` declaration is prepended by the provider). */
function toolCall(name: string, args: ToolCall['arguments'] = {}): FauxResponseStep {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
}

/** Seed the LOST precondition through the real SDK — replacement is only allowed FROM a lost card. */
async function reportCreditLost(): Promise<void> {
  const lost = await banking.card.reportLostCard(CARD, DEMO_USER_ID, { reason: '遗失' });
  expect(lost.status).toBe('LOST');
}

/** Every card owned by the demo user (the replacement is a brand-new row). */
function userCards() {
  return db().card.findMany({ where: { userId: DEMO_USER_ID } });
}

async function balanceMinor(): Promise<bigint> {
  return (await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
}

/** Drive ONE production turn whose scripted model proposes the RED `replace_card` call. */
async function proposeReplace(): Promise<{
  turn: ChatTurnResponse;
  script: { provider: ModelRuntime; calls(): number };
  actionId: string;
}> {
  const script = scriptedProvider({ purpose: 'operation', operations: ['replace_card'] }, [
    toolCall('replace_card', { cardId: CARD }),
    fauxAssistantMessage(BLOCKED_NARRATION),
  ]);
  const turn = await runTurn({ message: USER_REQUEST }, { config, provider: script.provider });
  const pending = await db().pendingAction.findFirstOrThrow({
    where: { sessionId: turn.sessionId, toolName: 'replace_card' },
  });
  return { turn, script, actionId: pending.id };
}

describe('Scenario 19 — 补办信用卡 (生产运行时 RED MFA replace_card)', () => {
  it('parks a RED awaiting_mfa PendingAction through the production runtime and mints NO card yet', async () => {
    await reportCreditLost();
    const before = await userCards();
    const beforeBalance = await balanceMinor();

    const { turn, script, actionId } = await proposeReplace();

    // The declaration plus the blocked call, and NOTHING more: RED ends the turn awaiting MFA, so the
    // trailing narration step is never requested — the model cannot narrate an unverified mutation.
    expect(script.calls()).toBe(2);
    // The production entry recorded the model's own interpretation as a `describe_turn` invocation.
    expect(await db().toolInvocation.count({ where: { toolName: 'describe_turn' } })).toBe(1);

    // RED ends the turn awaiting MFA — a real gate, never a prose claim.
    expect(hasGate(turn)).toBe(true);
    expect(turn.events.some(event => event.type === 'mfa_required')).toBe(true);
    const replaceEvents = turn.events.flatMap(event =>
      event.type === 'tool_end' && event.toolEvent.toolName === 'replace_card' ? [event.toolEvent] : []);
    expect(replaceEvents.length).toBeGreaterThan(0);
    expect(replaceEvents.every(view => view.status === 'blocked')).toBe(true);

    const row = await db().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(row.sessionId).toBe(turn.sessionId);
    expect(row.toolName).toBe('replace_card');
    expect(row.riskLevel).toBe('RED');
    expect(row.requiresMfa).toBe(true);
    expect(row.status).toBe('awaiting_mfa');
    // The gateway persisted the ORIGINAL validated args (executed later, never model text).
    expect(JSON.parse(row.argsJson)).toEqual({ cardId: CARD });

    // NOTHING was written while the human decision is outstanding.
    expect(await userCards()).toHaveLength(before.length);
    expect((await db().card.findUniqueOrThrow({ where: { id: CARD } })).replacedByCardId).toBeNull();
    expect(await balanceMinor()).toBe(beforeBalance);
    expect(await db().executionReceipt.count()).toBe(0);
  });

  it('verifyAction(123456) mints exactly ONE ACTIVE CREDIT replacement and keeps the source LOST', async () => {
    await reportCreditLost();
    const before = await userCards();
    const beforeBalance = await balanceMinor();
    const { turn, script, actionId } = await proposeReplace();

    const decision = await verifyAction(actionId, MFA_CODE, {
      sessionId: turn.sessionId,
      userId: DEMO_USER_ID,
      deps: { config, provider: script.provider },
    });
    expect(decision.ok).toBe(true);
    // `confirmed` is the CAS out of awaiting_mfa; the settled outcome of a mutation is `executed`.
    expect(decision.status).toBe('executed');
    expect(decision.requiresMfa).toBe(true);
    // A mutation outcome is a server-authored receipt: no extra model execution turn is required.
    expect(script.calls()).toBe(2);

    const after = await userCards();
    expect(after).toHaveLength(before.length + 1);

    // The source stays terminally LOST and points at exactly ONE replacement.
    const source = await db().card.findUniqueOrThrow({ where: { id: CARD } });
    expect(source.status).toBe('LOST');
    expect(source.replacedByCardId).not.toBeNull();

    const replacement = await db().card.findUniqueOrThrow({ where: { id: source.replacedByCardId! } });
    expect(replacement.userId).toBe(DEMO_USER_ID);
    expect(replacement.type).toBe('CREDIT');
    expect(replacement.status).toBe('ACTIVE');
    expect(replacement.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(replacement.numberMasked).not.toBe(source.numberMasked);
    // Replacement issues a card; it never moves cash.
    expect(await balanceMinor()).toBe(beforeBalance);

    expect((await db().pendingAction.findUniqueOrThrow({ where: { id: actionId } })).status).toBe('executed');
    // The blocked turn published the MFA gate instead of model prose: there is NO assistant text at all,
    // so the model could never claim a card had been issued while the human decision was outstanding.
    expect(finalContent(turn)).toBe('');
  });

  it('records a RED audit row with mfaRequired true, mfaResult success and confirmed true', async () => {
    await reportCreditLost();
    const { turn, script, actionId } = await proposeReplace();

    await verifyAction(actionId, MFA_CODE, {
      sessionId: turn.sessionId,
      userId: DEMO_USER_ID,
      deps: { config, provider: script.provider },
    });

    const rows = await db().auditLog.findMany({
      where: { sessionId: turn.sessionId, toolName: 'replace_card', status: 'success' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const audit = rows.find(row => row.mfaResult === 'success') ?? rows[0];
    expect(audit.riskLevel).toBe('RED');
    expect(audit.mfaRequired).toBe(true);
    expect(audit.mfaResult).toBe('success');
    expect(audit.confirmed).toBe(true);
    // The replacement is evidence-backed: exactly one successful execution of this action.
    expect(await db().executionReceipt.count({ where: { toolName: 'replace_card' } })).toBe(1);
  });
});
