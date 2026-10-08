/**
 * integration/message-protocol.test.ts — the persisted pi transcript must stay PROVIDER-VALID.
 *
 * DeepSeek (and the OpenAI chat API generally) reject a transcript in which a `tool` message is not
 * the direct response to the immediately-preceding assistant message declaring the matching
 * `tool_call`:
 *   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'".
 * pi models that relation with `role:'toolResult'` (its `convertToLlm` maps it to the wire role
 * `tool`), so pi's persisted `AgentSession.stateJson.messages` must obey the same adjacency rule.
 *
 * The fix this spec LOCKS IN lives in `agent/message-normalize.ts`:
 *  - `normalizeToolResultMessages` prunes orphan/duplicate `toolResult`s when the Agent is
 *    CONSTRUCTED/RESTORED (`agent/banking-agent.ts`), so a transcript written by an older build is
 *    healed on load;
 *  - `withRealToolResult` REPLACES the turn-time (blocked) placeholder IN PLACE in
 *    `agent/run-turn.ts#resumeTurn` — it never appends a second result for the same `toolCallId`
 *    after the turn-time narration (the OLD shape: `[...messages, realResult]`), which is exactly
 *    what tripped the provider 400.
 *
 * INVARIANT (asserted here as an INDEPENDENT oracle — NOT by re-using the production normalizer):
 * in the PERSISTED state, EVERY `role:'toolResult'` message answers a PRECEDING assistant message
 * that declares a `toolCall` with a MATCHING id; there is NO orphan result, NO duplicate id and NO
 * fabricated id.
 *
 * Pipeline exercised (nothing mocked — real facade): `POST /api/chat`'s `@/agent.runTurn`
 * (GREEN `search_contact` executes inline, the YELLOW/RED `transfer_money` is BLOCKED by the
 * security gateway → a `PendingAction` parks), then `@/agent.confirmAction` / `verifyAction` (the
 * production two-phase continuation that executes the ORIGINAL args and calls `resumeTurn`, which
 * persists the session). The model is the deterministic mock (`LLM_MODE=mock`); the tools, the
 * security chokepoint and the isolated test SQLite are the production ones.
 *
 * DB: `prisma/test.db` + `helpers/db.resetDatabase()` per test; a UNIQUE session per test
 * (`getOrCreateSession`) keeps the process-local circuit breaker / confirmation registry isolated.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai';
import { confirmAction, getOrCreateSession, loadSession, runTurn, saveSession, verifyAction } from '@/agent';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

beforeEach(async () => {
  await resetDatabase();
}, 60000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------ message type guards */

function roleOf(message: AgentMessage): string | undefined {
  return (message as { role?: string }).role;
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return roleOf(message) === 'assistant';
}

function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return roleOf(message) === 'toolResult';
}

/* ------------------------------------------------------------------ invariant oracle */

/** The result of an INDEPENDENT walk of a pi transcript against the provider adjacency rule. */
interface TranscriptAnalysis {
  /** Every `toolCall.id` an assistant message declares, in transcript order. */
  declaredCallIds: string[];
  /** Every `toolResult.toolCallId`, in transcript order. */
  resultIds: string[];
  /** Human-readable invariant breaches; EMPTY means the transcript is provider-valid. */
  violations: string[];
}

/**
 * Independently re-derive the invariant the fix guarantees. A transcript is VALID iff every
 * `toolResult` sits inside the contiguous result run opened by an assistant message that declares
 * its `toolCallId` (so every result answers a PRECEDING, matching `toolCall`), each call id is
 * answered at most once (no duplicate), and every result id was actually declared (no fabricated
 * id). This deliberately re-implements the rule instead of calling the production normalizer, so a
 * regression in the fix cannot satisfy the assertion by construction.
 */
function analyzeTranscript(messages: readonly AgentMessage[]): TranscriptAnalysis {
  const declaredCallIds: string[] = [];
  const resultIds: string[] = [];
  const violations: string[] = [];
  const seenResultIds = new Set<string>();

  // `openCalls` = ids declared by the assistant message owning the current contiguous result run
  // (null once a non-`toolCall` message closes it); `answeredInRun` = ids already answered in it.
  let openCalls: Set<string> | null = null;
  let answeredInRun = new Set<string>();

  messages.forEach((message, index) => {
    if (isToolResult(message)) {
      const id = message.toolCallId;
      resultIds.push(id);
      if (seenResultIds.has(id)) {
        violations.push(`duplicate toolResult id '${id}' (index ${index})`);
      }
      seenResultIds.add(id);
      if (openCalls === null) {
        violations.push(`orphan toolResult '${id}' (index ${index}): no preceding assistant toolCall`);
      } else if (!openCalls.has(id)) {
        violations.push(
          `orphan toolResult '${id}' (index ${index}): not declared by the preceding assistant`,
        );
      } else if (answeredInRun.has(id)) {
        violations.push(`duplicate toolResult '${id}' within its run (index ${index})`);
      }
      answeredInRun.add(id);
      return;
    }

    // Any non-result message (user / assistant) closes the previous run; an assistant that declares
    // `toolCall`s opens a fresh one.
    const declared: string[] = [];
    if (isAssistant(message)) {
      for (const part of message.content) {
        if (part.type === 'toolCall') declared.push(part.id);
      }
    }
    declaredCallIds.push(...declared);
    openCalls = declared.length > 0 ? new Set(declared) : null;
    answeredInRun = new Set();
  });

  // No FABRICATED id: every result id must have been declared by SOME assistant message.
  for (const id of seenResultIds) {
    if (!declaredCallIds.includes(id)) {
      violations.push(`fabricated toolResult id '${id}': no assistant message ever declared it`);
    }
  }

  return { declaredCallIds, resultIds, violations };
}

/** Every `toolCall` id an assistant message declares for the named tool, in transcript order. */
function toolCallIdsNamed(messages: readonly AgentMessage[], name: string): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (!isAssistant(message)) continue;
    for (const part of message.content) {
      if (part.type === 'toolCall' && part.name === name) ids.push(part.id);
    }
  }
  return ids;
}

/** The parked human-decision a turn surfaced (YELLOW confirmation or RED MFA). */
function parkedDecision(
  events: readonly AgentStreamEvent[],
): { kind: 'confirmation' | 'mfa'; actionId: string } | null {
  for (const event of events) {
    if (event.type === 'confirmation_required') return { kind: 'confirmation', actionId: event.actionId };
    if (event.type === 'mfa_required') return { kind: 'mfa', actionId: event.actionId };
  }
  return null;
}

/* ------------------------------------------------------------------ shared assertions */

/** Assert the persisted transcript satisfies the provider adjacency invariant, EXACTLY. */
function expectValidTranscript(messages: readonly AgentMessage[]): TranscriptAnalysis {
  const analysis = analyzeTranscript(messages);
  expect(analysis.violations).toEqual([]);
  // Every declared call is answered by EXACTLY ONE result, in the same order — no orphan, no
  // duplicate, no fabricated id (all three follow from violations being empty plus this equality).
  expect(analysis.resultIds).toEqual(analysis.declaredCallIds);
  return analysis;
}

/** Load the persisted snapshot's pi messages, failing loudly when the session is missing. */
async function persistedMessages(sessionId: string): Promise<readonly AgentMessage[]> {
  const snapshot = await loadSession(sessionId);
  if (snapshot === null) throw new Error(`expected a persisted session: ${sessionId}`);
  return snapshot.agentState.messages;
}

/* ------------------------------------------------------------------ tests */

describe('message-protocol — the persisted pi transcript stays provider-valid', () => {
  it('a YELLOW park → confirm persists a transcript where every toolResult answers a preceding toolCall', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);

    // Turn 1: the model emits search_contact (GREEN, executes inline) then transfer_money (YELLOW,
    // BLOCKED) → the gateway parks a `PendingAction` and the session is persisted.
    const turn = await runTurn({ sessionId, message: '给张伟转200元，备注AA' });
    expect(turn.sessionId).toBe(sessionId);
    const decision = parkedDecision(turn.events);
    expect(decision?.kind).toBe('confirmation');
    if (decision === null) throw new Error('expected a parked confirmation');

    // The park transcript is already valid, and its ONE transfer call id is known.
    const parkedMessages = await persistedMessages(sessionId);
    const parkedAnalysis = expectValidTranscript(parkedMessages);
    const transferCallIds = toolCallIdsNamed(parkedMessages, 'transfer_money');
    expect(transferCallIds).toHaveLength(1);
    const transferCallId = transferCallIds[0];
    expect(parkedAnalysis.declaredCallIds).toContain(transferCallId);

    // Turn 2: the human confirms → the REAL args execute and `resumeTurn` persists the narration.
    const outcome = await confirmAction(decision.actionId);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    // After a refresh (re-load through the facade) the invariant holds, with EXACT ids: the transfer
    // call is answered exactly once (the real result REPLACED the blocked placeholder in place).
    const analysis = expectValidTranscript(await persistedMessages(sessionId));
    expect(analysis.resultIds.filter((id) => id === transferCallId)).toEqual([transferCallId]);
    expect(analysis.declaredCallIds).toContain(transferCallId);

    // A second refresh is byte-identical — the fix is idempotent, not a one-shot in-memory repair.
    const again = expectValidTranscript(await persistedMessages(sessionId));
    expect(again.resultIds).toEqual(analysis.resultIds);
  });

  it('heals a persisted transcript carrying TWO toolResults for the SAME call id (the shape the OLD resumeTurn produced)', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);

    const turn = await runTurn({ sessionId, message: '给张伟转200元，备注AA' });
    const decision = parkedDecision(turn.events);
    expect(decision?.kind).toBe('confirmation');
    if (decision === null) throw new Error('expected a parked confirmation');

    // Baseline: the park transcript is exactly valid.
    const parkedMessages = await persistedMessages(sessionId);
    expectValidTranscript(parkedMessages);
    const transferCallIds = toolCallIdsNamed(parkedMessages, 'transfer_money');
    expect(transferCallIds).toHaveLength(1);
    const transferCallId = transferCallIds[0];

    // Seed the EXACT defect the OLD `resumeTurn` produced: a SECOND `toolResult` for the SAME call id,
    // appended AFTER the turn-time narration (a non-`toolCall` assistant message) — so the duplicate
    // result sits outside its assistant call's run. This is the transcript DeepSeek rejects with the
    // "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'" 400.
    const snapshot = await loadSession(sessionId);
    if (snapshot === null) throw new Error('expected a persisted session');
    const duplicate: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: transferCallId,
      toolName: 'transfer_money',
      content: [{ type: 'text', text: '转账处理结果：已成功转出（旧版 resumeTurn 追加的重复结果）' }],
      details: { ok: true, summary: '已成功转出' },
      isError: false,
      timestamp: Date.now(),
    };
    snapshot.agentState.messages = [...parkedMessages, duplicate];
    await saveSession(snapshot);

    // The seeded transcript is GENUINELY broken — this is what the OLD behavior left behind, and it
    // would FAIL the invariant assertions below. Proving the seed reproduces the defect (rather than
    // trivially passing) is what makes this case a real regression guard.
    const broken = analyzeTranscript(await persistedMessages(sessionId));
    expect(broken.violations.length).toBeGreaterThan(0);
    expect(broken.resultIds.filter((id) => id === transferCallId)).toHaveLength(2);

    // Proceed through the REAL facade: the confirm executes the parked action and `resumeTurn`
    // persists a HEALED transcript (the orphan/duplicate is dropped on restore + normalize).
    const outcome = await confirmAction(decision.actionId);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    const healed = expectValidTranscript(await persistedMessages(sessionId));
    // Exactly ONE result now answers the transfer call — the OLD duplicate is GONE, and no fabricated
    // id took its place.
    expect(healed.resultIds.filter((id) => id === transferCallId)).toEqual([transferCallId]);
    expect(healed.declaredCallIds).toContain(transferCallId);
  });

  it('a RED park → verify(123456) persists a transcript where every toolResult answers a preceding toolCall', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);

    // Turn 1: transfer ¥5,000 is RED → the gateway parks it for strong verification (MFA).
    const turn = await runTurn({ sessionId, message: '给张伟转5000元' });
    expect(turn.sessionId).toBe(sessionId);
    const decision = parkedDecision(turn.events);
    expect(decision?.kind).toBe('mfa');
    if (decision === null) throw new Error('expected a parked MFA decision');

    const parkedMessages = await persistedMessages(sessionId);
    const parkedAnalysis = expectValidTranscript(parkedMessages);
    const transferCallIds = toolCallIdsNamed(parkedMessages, 'transfer_money');
    expect(transferCallIds).toHaveLength(1);
    const transferCallId = transferCallIds[0];
    expect(parkedAnalysis.declaredCallIds).toContain(transferCallId);

    // Turn 2: the human verifies the mock MFA code → execute + `resumeTurn` persists the narration.
    const outcome = await verifyAction(decision.actionId, MFA_CODE);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    const analysis = expectValidTranscript(await persistedMessages(sessionId));
    expect(analysis.resultIds.filter((id) => id === transferCallId)).toEqual([transferCallId]);
  });
});
