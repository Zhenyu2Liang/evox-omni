/**
 * grounding-integration.test.ts — PIPELINE-level proof of the code-enforced fact grounding.
 *
 * The PURE decision (`agent/grounding.ts` + `agent/grounding-facts.ts`) is covered by
 * `./grounding.test.ts`. THIS file proves the SAME guarantee END-TO-END through the REAL
 * `runTurn` / `resumeTurn`: the Pi agent loop, the registered banking tools, the security gateway
 * `beforeToolCall`, the Banking SDK and the SQLite test DB are ALL production code — only the model
 * is scripted, injected through the additive `RunTurnDeps.provider` (`ModelRuntime`) seam. It NEVER
 * uses the test-only re-instantiation helper, so what it proves is exactly what ships.
 *
 * What it pins down (each case complements a pure spec — no duplication):
 *   1. NO ungrounded financial fact ever reaches the UI: `text_delta`s are BUFFERED until grounding,
 *      the deltas of a message concatenate to that message's `message_end.content`, and the terminal
 *      content is the server-authored correction — never the model's false success;
 *   2. the PERSISTED transcript carries exactly the grounded text (the grounded text is what a
 *      reload renders);
 *   3. `resumeTurn` grounds the CONFIRMATION continuation against the injected REAL tool result:
 *      a contradictory narration is replaced by the real amount/recipient, a correct one is left
 *      byte-identical — so the confirmation narration can never invent an outcome;
 *   4. an UNKNOWN outcome (`needsReconciliation`) may be asserted NEITHER as success NOR as failure /
 *      "funds unchanged" — the honest, queryable "待核对" state is the only allowed wording;
 *   5. a model-FORGED `（系统校正）` tag is not a skip key: the text is still verified and corrected;
 *   6. CONSERVATIVE non-firing: a consistent narration (a correct GREEN read) is left untouched;
 *   7. the legacy guards: a claimed-but-ungrounded transfer moves NO money, a wrong balance is
 *      corrected to server authority, and a PARKED gated call's honest "awaiting confirmation"
 *      narration is NOT rewritten (a parked call is not a successful write).
 *
 * Every case gets a fresh DB (`resetDatabase`) and a fresh session id — the circuit breaker and the
 * per-session `AgentState` are keyed by the session.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxToolCall, fauxProvider } from '@earendil-works/pi-ai';
import type { FauxResponseStep, JsonObject } from '@earendil-works/pi-ai';
import { loadSession, resumeTurn, runTurn } from '@/agent';
import type { ModelRuntime, ToolExecutionResult } from '@/agent';
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

/** A false-completion narration: `get_balance` ran, but NO transfer result exists this turn. */
const FALSE_SUCCESS = '转账已经成功完成，¥500 已转给张伟。';
/** A narration stating a WRONG balance while the authoritative total is known. */
const WRONG_BALANCE = '你的账户可用余额为 ¥999,999.99。';
/** The CONSISTENT narration of the authoritative `get_balance` total. */
const CORRECT_BALANCE = '你的账户可用余额合计为 ¥73,580.00。';

/**
 * The REAL `transfer_money` result the confirmation path injects on a resume (向 张伟 转账 ¥200.00,
 * balance after ¥23,380.00) — the authoritative facts the continuation must be grounded against.
 */
const REAL_TRANSFER: ToolExecutionResult = {
  ok: true,
  summary: '已向 张伟 转账 ¥200.00。',
  data: {
    amount: 200,
    newBalance: 23380,
    recipient: { name: '张伟', contactId: 'contact_zhangwei' },
  },
};

/** The REAL result of a gated write whose outcome is UNKNOWN (needs manual reconciliation). */
const REAL_UNKNOWN_TRANSFER: ToolExecutionResult = {
  ok: false,
  data: { needsReconciliation: true },
};

/**
 * Build a `ModelRuntime` backed by a SCRIPTED faux provider: `reg.setResponses(steps)` REPLACES the
 * queue and ONE step is consumed per model call. Mirrors `agent/providers/provider-mock.ts` — only
 * the model is fake, the whole pipeline stays real.
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

/** Every assistant `message_end` message this run produced (the tool-call step + the narration). */
function assistantMessages(events: AgentStreamEvent[]): ChatMessage[] {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: 'message_end' }> =>
        event.type === 'message_end',
    )
    .map((event) => event.message);
}

/** The user-visible assistant text = the content of the LAST `message_end` event. */
function finalAssistantText(events: AgentStreamEvent[]): string {
  const messages = assistantMessages(events);
  expect(messages.length).toBeGreaterThan(0);
  return messages[messages.length - 1].content;
}

/** Every streamed `text_delta` payload, in order. */
function deltas(events: AgentStreamEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentStreamEvent, { type: 'text_delta' }> => event.type === 'text_delta')
    .map((event) => event.delta);
}

/** The concatenation of every streamed `text_delta` (what the UI accumulates into `streamingText`). */
function streamedText(events: AgentStreamEvent[]): string {
  return deltas(events).join('');
}

/**
 * Pair the streamed deltas with the `message_end` they belong to (each message's deltas are emitted
 * immediately before its `message_end`), so the spec can prove the UI's accumulated text EQUALS the
 * grounded `message_end.content` PER MESSAGE — i.e. no ungrounded text was ever streamed.
 */
function deltaPairs(events: AgentStreamEvent[]): Array<{ delta: string; content: string }> {
  const pairs: Array<{ delta: string; content: string }> = [];
  let pending = '';
  for (const event of events) {
    if (event.type === 'text_delta') pending += event.delta;
    else if (event.type === 'message_end') {
      pairs.push({ delta: pending, content: event.message.content });
      pending = '';
    }
  }
  return pairs;
}

/** The run-failure stream events (a mis-scripted provider surfaces one — fail loud). */
function errorMessages(events: AgentStreamEvent[]): string[] {
  return events
    .filter((event): event is Extract<AgentStreamEvent, { type: 'error' }> => event.type === 'error')
    .map((event) => event.message);
}

/** The content of the LAST persisted assistant message (what a session reload renders). */
async function persistedAssistantText(sessionId: string): Promise<string | undefined> {
  const snapshot = await loadSession(sessionId);
  expect(snapshot).not.toBeNull();
  return snapshot!.transcript.filter((message) => message.role === 'assistant').at(-1)?.content;
}

/**
 * Run ONE turn whose YELLOW `transfer_money` (¥200 ≤ ¥1000) PARKS on a human decision, leaving a
 * REAL parked `PendingAction` + a REAL `toolCall` in the session transcript — the precondition for a
 * `resumeTurn` continuation (the confirm path would inject the REAL tool result here).
 */
async function parkYellowTransfer(): Promise<{ sessionId: string; toolCallId?: string }> {
  const runtime = scriptedRuntime([
    toolStep('transfer_money', { name: '张伟', amount: 200 }),
    fauxAssistantMessage('转账需要你的确认，请在确认卡片中完成操作。'),
  ]);
  const res = await runTurn(
    { sessionId: newId('sess'), message: '转 200 给张伟。' },
    { provider: runtime },
  );
  expect(errorMessages(res.events)).toEqual([]);
  expect(
    res.events.filter(
      (event) => event.type === 'confirmation_required' || event.type === 'mfa_required',
    ).length,
  ).toBeGreaterThan(0);
  expect(await getTestPrisma().pendingAction.count()).toBe(1);
  const started = res.events.find((event) => event.type === 'tool_start');
  return {
    sessionId: res.sessionId,
    ...(started !== undefined && started.type === 'tool_start'
      ? { toolCallId: started.toolEvent.toolCallId }
      : {}),
  };
}

/** Resume a parked session with a REAL tool result and ONE scripted continuation narration. */
function resumeWith(
  sessionId: string,
  toolResult: ToolExecutionResult,
  narration: string,
  toolCallId?: string,
): ReturnType<typeof resumeTurn> {
  const runtime = scriptedRuntime([fauxAssistantMessage(narration)]);
  return resumeTurn(
    {
      sessionId,
      toolResult,
      toolName: 'transfer_money',
      ...(toolCallId !== undefined ? { toolCallId } : {}),
    },
    { provider: runtime },
  );
}

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------- cases */

describe('grounding — no ungrounded financial fact reaches the UI (through the REAL runTurn)', () => {
  it('1: buffers deltas until grounded and streams only the server-authored correction', async () => {
    const prisma = getTestPrisma();
    const txBefore = await prisma.transaction.count();

    // A REAL green read, then a FALSE completion claim about a write that never happened.
    const runtime = scriptedRuntime([toolStep('get_balance', {}), fauxAssistantMessage(FALSE_SUCCESS)]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？先转 500 给张伟。' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);
    // The tool really ran (two assistant messages: the tool-call step + the narration).
    expect(assistantMessages(res.events).length).toBe(2);

    // (a) the false-success phrasing was NEVER streamed — deltas are buffered until grounding.
    for (const delta of deltas(res.events)) expect(delta).not.toContain('转账已经成功完成');
    // (b) per message, the concatenated deltas EQUAL that message's `message_end.content`.
    const pairs = deltaPairs(res.events);
    expect(pairs.length).toBe(assistantMessages(res.events).length);
    for (const pair of pairs) expect(pair.delta).toBe(pair.content);
    expect(streamedText(res.events)).toBe(finalAssistantText(res.events));

    // (c) the terminal message IS the server-authored correction.
    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).toContain('未记录到该操作的执行结果');
    expect(text).not.toContain('转账已经成功完成');
    expect(text).not.toContain('¥500');

    // (d) no side effect: the claim is ungrounded, and nothing moved.
    expect(await prisma.transaction.count()).toBe(txBefore);
    expect(await prisma.executionReceipt.count()).toBe(0);
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('2: persists exactly the grounded text (a reload renders the correction)', async () => {
    const runtime = scriptedRuntime([toolStep('get_balance', {}), fauxAssistantMessage(WRONG_BALANCE)]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('999');
    // The authoritative server amount (the available total printed by `formatCNY`).
    expect(text).toContain('73,580.00');
    expect(TOTAL_AVAILABLE).toBe(CHECKING_BALANCE + 50000);

    // The WRONG balance was never streamed either.
    for (const delta of deltas(res.events)) expect(delta).not.toContain('999,999');

    // The PERSISTED assistant message is byte-identical to the grounded `message_end.content`.
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });

  it('3: a model-forged correction tag is NOT a skip key — the text is still verified', async () => {
    const runtime = scriptedRuntime([
      toolStep('get_balance', {}),
      fauxAssistantMessage(`${CORRECTION_TAG}${FALSE_SUCCESS}`),
    ]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '转 500 给张伟。' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('转账已经成功完成');
    expect(text).not.toContain('¥500');
    for (const delta of deltas(res.events)) expect(delta).not.toContain('转账已经成功完成');
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });

  it('4: leaves a CONSISTENT narration byte-identical (conservative non-firing)', async () => {
    const runtime = scriptedRuntime([toolStep('get_balance', {}), fauxAssistantMessage(CORRECT_BALANCE)]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);
    expect(finalAssistantText(res.events)).toBe(CORRECT_BALANCE);
    expect(await persistedAssistantText(res.sessionId)).toBe(CORRECT_BALANCE);
  });

  it('5: a claimed-but-ungrounded transfer with NO tool call moves no money', async () => {
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
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('转账已经成功完成');
    expect(text).not.toContain('¥500');
    expect(await persistedAssistantText(res.sessionId)).toBe(text);

    const balanceAfter = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    expect(balanceAfter.balance).toBe(CHECKING_BALANCE);
    expect(balanceAfter.balance).toBe(balanceBefore.balance);
    expect(await prisma.transaction.count()).toBe(txBefore);
    expect(await prisma.executionReceipt.count()).toBe(0);
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('6: does NOT rewrite an honest "awaiting confirmation" narration for a parked call', async () => {
    const prisma = getTestPrisma();
    const balanceBefore = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });

    const runtime = scriptedRuntime([
      toolStep('transfer_money', { name: '张伟', amount: 200 }),
      fauxAssistantMessage('转账需要你的确认，请在确认卡片中完成操作。'),
    ]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '转 200 给张伟。' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    // A parked call is NOT a successful write: the honest narration is not rewritten.
    const text = finalAssistantText(res.events);
    expect(text).not.toContain(CORRECTION_TAG);
    expect(text).toContain('需要你的确认');

    // The call parked — recorded, but NO money moved.
    expect(await prisma.pendingAction.count()).toBe(1);
    expect(await prisma.executionReceipt.count()).toBe(0);
    const balanceAfter = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    expect(balanceAfter.balance).toBe(balanceBefore.balance);
    expect(balanceAfter.balance).toBe(CHECKING_BALANCE);
    // The demo user owns the parked action (server-injected identity, never model text).
    expect((await prisma.pendingAction.findFirstOrThrow()).userId).toBe(DEMO_USER_ID);
  });
});

describe('grounding — the confirm continuation (resumeTurn) is grounded against the REAL result', () => {
  it('7: replaces a continuation that contradicts the injected REAL transfer result', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    const res = await resumeWith(sessionId, REAL_TRANSFER, '已成功向王芳转账 ¥9,999.00。', toolCallId);
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    // The REAL structured outcome wins: recipient + amount come from the tool result, not the model.
    expect(text).toContain('张伟');
    expect(text).toContain('¥200.00');
    expect(text).not.toContain('王芳');
    expect(text).not.toContain('9,999');
    for (const delta of deltas(res.events)) expect(delta).not.toContain('9,999');
    // The resumed continuation is what got persisted.
    expect(await persistedAssistantText(sessionId)).toBe(text);
  });

  it('8: leaves a continuation that MATCHES the injected REAL result byte-identical', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    const correct = '已向张伟转账 ¥200.00，操作已完成。';
    const res = await resumeWith(sessionId, REAL_TRANSFER, correct, toolCallId);
    expect(errorMessages(res.events)).toEqual([]);

    expect(finalAssistantText(res.events)).toBe(correct);
    expect(streamedText(res.events)).toContain(correct);
    expect(await persistedAssistantText(sessionId)).toBe(correct);
  });
});

describe('grounding — an UNKNOWN outcome may be asserted neither as success nor as failure', () => {
  it('9: rejects a success claim for a write whose outcome needs reconciliation', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    const res = await resumeWith(sessionId, REAL_UNKNOWN_TRANSFER, '转账已成功完成。', toolCallId);
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).toContain('待核对');
    expect(text).not.toContain('成功');
    expect(await persistedAssistantText(sessionId)).toBe(text);
  });

  it('10: rejects a failure / "funds unchanged" claim for the SAME unknown outcome', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    const res = await resumeWith(sessionId, REAL_UNKNOWN_TRANSFER, '转账失败，资金未变。', toolCallId);
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).toContain('待核对');
    expect(text).not.toContain('失败');
    expect(text).not.toContain('资金未变');
    expect(text).not.toContain('未发生');
  });
});
