/**
 * grounding-integration.test.ts — SERVER-SIDE FACT GROUNDING, proven END-TO-END through the REAL
 * `runTurn` (not `groundAssistantText` in isolation).
 *
 * `agent/grounding.ts` is the code-enforced HALLUCINATION GUARD: the model's final prose is RAW
 * output and is REPLACED by a server-authored correction whenever it contradicts the authoritative
 * facts of the turn's REAL tool results. `agent/run-turn.ts` wires it at the assistant `message_end`
 * chokepoint (and re-grounds before `saveSession`), and the `message_end` stream event references
 * that SAME grounded message object — so the text this spec reads off the LAST `message_end` event in
 * `res.events` is exactly the text the UI renders.
 *
 * The model is the ONLY scripted part: `RunTurnDeps.provider` (the additive `ModelRuntime` seam)
 * injects a `fauxProvider()`-backed `{ model, streamFn }` pair. Everything else — the Pi agent loop,
 * the registered banking tools, the security gateway `beforeToolCall`, the Banking SDK and the SQLite
 * test DB — is production code. `LLM_MODE=mock` (vitest.agent.config.ts) keeps the run fully offline.
 *
 * Cases (each uses a fresh DB + a fresh session id — the circuit breaker is keyed by sessionId):
 *   (a) a model that CLAIMS a completed transfer without ever calling a tool is corrected and moves
 *       NO money (the false-success suppression + the "no hidden side effect" guarantee);
 *   (b) a model that reports a WRONG balance after a real `get_balance` call is corrected to the
 *       authoritative server amount;
 *   (c) a GATED tool that PARKS is not counted as a successful write, so the honest
 *       "awaiting confirmation" narration is NOT rewritten.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxToolCall, fauxProvider } from '@earendil-works/pi-ai';
import type { FauxResponseStep, JsonObject } from '@earendil-works/pi-ai';
import { loadSession, runTurn } from '@/agent';
import type { ModelRuntime } from '@/agent';
import type { AgentStreamEvent, ChatMessage } from '@/lib/contracts/agent';
import { newId } from '@/lib/ids';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

/* ------------------------------------------------------------------------------------- harness */

/** The server tag marking a text the server already corrected (`agent/grounding.ts`). */
const CORRECTION_TAG = '（系统校正）';

/** The seeded 活期 balance and its authoritative available total (¥23,580 + ¥50,000 savings). */
const CHECKING_BALANCE = 23580;
const TOTAL_AVAILABLE = 73580;

/**
 * Build a `ModelRuntime` backed by a SCRIPTED faux provider: `reg.setResponses(steps)` REPLACES the
 * queue and ONE step is consumed per model call. Mirrors `agent/providers/provider-mock.ts` +
 * `tests/helpers/faux-agent.ts` — only the model is fake, the whole pipeline stays real.
 */
function scriptedRuntime(steps: FauxResponseStep[]): ModelRuntime {
  const reg = fauxProvider();
  const models = createModels();
  models.setProvider(reg.provider);
  reg.setResponses(steps);
  return { model: reg.getModel(), streamFn: models.streamSimple.bind(models) };
}

/** A scripted step that PROPOSES a tool call (this is what makes the agent loop run the tool). */
function toolStep(tool: string, args: Record<string, unknown>): FauxResponseStep {
  return fauxAssistantMessage(
    [fauxToolCall(tool, JSON.parse(JSON.stringify(args)) as JsonObject)],
    { stopReason: 'toolUse' },
  );
}

/** The user-visible assistant text = the content of the LAST `message_end` event. */
function finalAssistantText(events: AgentStreamEvent[]): string {
  const ends = events.filter(
    (event): event is Extract<AgentStreamEvent, { type: 'message_end' }> =>
      event.type === 'message_end',
  );
  expect(ends.length).toBeGreaterThan(0);
  return ends[ends.length - 1].message.content;
}

/** Every assistant `message_end` message this turn produced (the tool-call step + the narration). */
function assistantMessages(events: AgentStreamEvent[]): ChatMessage[] {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: 'message_end' }> =>
        event.type === 'message_end',
    )
    .map((event) => event.message);
}

/** The run-failure stream events (a mis-scripted provider surfaces one — fail loud). */
function errorMessages(events: AgentStreamEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: 'error' }> => event.type === 'error',
    )
    .map((event) => event.message);
}

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------- cases */

describe('grounding — code-enforced end-to-end through runTurn', () => {
  it('(a) suppresses a claimed-but-ungrounded transfer and moves NO money', async () => {
    const prisma = getTestPrisma();
    const balanceBefore = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    const txBefore = await prisma.transaction.count();

    // ONE text-only step: the model claims a completed transfer it never performed (no tool call).
    const runtime = scriptedRuntime([fauxAssistantMessage('转账已经成功完成，¥500 已转给张伟。')]);

    const res = await runTurn(
      { sessionId: newId('sess'), message: '转 500 给张伟。' },
      { provider: runtime },
    );

    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    // The raw, false completion claim is GONE and the server correction is present.
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('转账已经成功完成');
    expect(text).not.toContain('¥500');

    // The corrected text is ALSO what got persisted (the UI transcript).
    const persisted = await loadSession(res.sessionId);
    expect(persisted).not.toBeNull();
    const persistedAssistant = persisted!.transcript.filter((m) => m.role === 'assistant');
    expect(persistedAssistant.at(-1)?.content).toBe(text);

    // NO money moved and NO side-effect row was written.
    const balanceAfter = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    expect(balanceAfter.balance).toBe(CHECKING_BALANCE);
    expect(balanceAfter.balance).toBe(balanceBefore.balance);
    expect(await prisma.transaction.count()).toBe(txBefore);
    expect(await prisma.executionReceipt.count()).toBe(0);
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('(b) corrects a wrong balance claim to the authoritative server amount', async () => {
    // Step 1: a real GREEN `get_balance` call. Step 2: a narration stating a WRONG balance.
    const runtime = scriptedRuntime([
      toolStep('get_balance', {}),
      fauxAssistantMessage('你的账户可用余额为 ¥999,999.99。'),
    ]);

    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？' },
      { provider: runtime },
    );

    expect(errorMessages(res.events)).toEqual([]);

    // The turn really ran the tool (two assistant messages: the tool-call step + the narration).
    expect(assistantMessages(res.events).length).toBe(2);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('999');
    // The authoritative server amount (the available total printed by `formatCNY`).
    expect(text).toMatch(/23,580|73,580/);
    expect(text).toContain('73,580.00');
    expect(TOTAL_AVAILABLE).toBe(CHECKING_BALANCE + 50000);
  });

  it('(c) does NOT rewrite an honest "awaiting confirmation" narration for a parked gated call', async () => {
    const prisma = getTestPrisma();
    const balanceBefore = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });

    // Step 1: propose a YELLOW `transfer_money` (¥200 ≤ ¥1000) — the gateway BLOCKS it and parks a
    // PendingAction. Step 2: the honest "awaiting confirmation" narration.
    const runtime = scriptedRuntime([
      toolStep('transfer_money', { name: '张伟', amount: 200 }),
      fauxAssistantMessage('转账需要你的确认，请在确认卡片中完成操作。'),
    ]);

    const res = await runTurn(
      { sessionId: newId('sess'), message: '转 200 给张伟。' },
      { provider: runtime },
    );

    expect(errorMessages(res.events)).toEqual([]);

    // The human-decision event was raised (a parked YELLOW action).
    const decision = res.events.filter(
      (event) => event.type === 'confirmation_required' || event.type === 'mfa_required',
    );
    expect(decision.length).toBeGreaterThan(0);

    // A parked call is NOT a successful write: the honest narration is NOT rewritten, and the
    // false-success rule does not fire (nothing was claimed as completed).
    const text = finalAssistantText(res.events);
    expect(text).not.toContain(CORRECTION_TAG);
    expect(text).toContain('需要你的确认');

    // The call parked — recorded, but NO money moved.
    expect(await prisma.pendingAction.count()).toBe(1);
    expect(await prisma.executionReceipt.count()).toBe(0);
    const balanceAfter = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    expect(balanceAfter.balance).toBe(balanceBefore.balance);
    expect(balanceAfter.balance).toBe(CHECKING_BALANCE);
  });
});
