/**
 * grounding-regression.test.ts — pins the code-enforced FINANCIAL-FACT GROUNDING ("ISSUE 1") through
 * the REAL agent pipeline.
 *
 * The model's prose is RAW output; `agent/grounding.ts#groundAssistantText` +
 * `agent/grounding-facts.ts#buildFinancialFacts` are the HALLUCINATION GUARD that compares the final
 * assistant text against the turn's REAL tool results and REPLACES an inconsistent message with a
 * server-authored correction. THIS suite proves that guarantee END-TO-END: `runTurn` / `resumeTurn`,
 * the Pi agent loop, the registered banking tools, the security-gateway `beforeToolCall` chokepoint,
 * the Banking SDK and the SQLite test DB are ALL production code — only the model is scripted, injected
 * through the additive `RunTurnDeps.provider` (`ModelRuntime`) seam.
 *
 * Everything here is asserted through the PUBLIC pipeline (stream events + `loadSession`); no business
 * logic is re-derived and grounding is never re-implemented.
 *
 * Guarantees pinned:
 *   - a claimed transfer with NO real `transfer_money` result (no tool, or an unrelated GREEN write)
 *     is corrected and moves NO money;
 *   - a balance claim is checked against the server-authoritative accounts (an inflated total, or the
 *     checking figure stated as the savings balance, is replaced by the real value);
 *   - the confirm continuation (`resumeTurn`) is grounded against the injected REAL result — the real
 *     recipient/amount win over a contradictory narration;
 *   - an UNKNOWN outcome (needs reconciliation) may be asserted NEITHER as success NOR as failure /
 *     "funds unchanged";
 *   - an ENGLISH false success and a MIXED success/failure narration are corrected, and a model-forged
 *     `（系统校正）` tag is NOT a skip key;
 *   - the streamed deltas, the terminal `message_end` content and the PERSISTED transcript all agree on
 *     the SAME grounded text (the false text is never streamed).
 *
 * Every case gets a fresh DB (`resetDatabase`) and a fresh session id — the circuit breaker and the
 * per-session `AgentState` are keyed by the session.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { FauxResponseStep, JsonObject } from '@earendil-works/pi-ai';
import { loadSession, resumeTurn, runTurn } from '@/agent';
import type { ModelRuntime, ToolExecutionResult } from '@/agent';
import type { AgentStreamEvent, ChatMessage } from '@/lib/contracts/agent';
import { newId } from '@/lib/ids';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
// The grounding DECISION is PURE and lives in `agent/grounding` (the `@/agent` facade does not
// re-export it). Importing the precedented subpath keeps this whole file compiling so the cases
// below fail as genuine ASSERTION failures, never as module-resolution errors.
import { buildFinancialFacts, groundAssistantText } from '@/agent/grounding';

/* ------------------------------------------------------------------------------------- harness */

/** The server tag marking a text the server already corrected (`agent/grounding.ts`). */
const CORRECTION_TAG = '（系统校正）';

/** The seeded 活期 balance and the authoritative available total (¥23,580 + ¥50,000 savings). */
const CHECKING_BALANCE = 23580;
const TOTAL_AVAILABLE = 73580;
const SAVINGS_BALANCE = 50000;

/** A false-completion narration: no real `transfer_money` result grounds it this turn. */
const FALSE_SUCCESS = '转账已经成功完成，¥500 已转给张伟。';

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
 * queue and ONE step is consumed per model call. Only the model is fake, the whole pipeline stays real.
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

/** Every assistant `message_end` message this run produced (the tool-call step(s) + the narration). */
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
 * `resumeTurn` continuation (the confirm path injects the REAL tool result here).
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
  // Scoped to THIS session so a case that parks more than once (fresh DB, two sessions) still proves
  // that this turn parked exactly one action.
  expect(
    await getTestPrisma().pendingAction.count({ where: { sessionId: res.sessionId } }),
  ).toBe(1);
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

describe('grounding — a transfer claim with no real transfer_money result is corrected', () => {
  it('1: a text-only false success is replaced and moves no money', async () => {
    const prisma = getTestPrisma();
    const balanceBefore = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    const txBefore = await prisma.transaction.count();

    // ONE text-only step: the model claims a completed transfer it never performed (no tool call).
    const runtime = scriptedRuntime([fauxAssistantMessage(FALSE_SUCCESS)]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '转 500 给张伟。' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);
    expect(assistantMessages(res.events).length).toBe(1);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('转账已经成功完成');
    expect(text).not.toContain('¥500');
    // The false phrasing was NEVER streamed.
    for (const delta of deltas(res.events)) expect(delta).not.toContain('转账已经成功完成');
    expect(await persistedAssistantText(res.sessionId)).toBe(text);

    // No side effect: the claim is ungrounded and nothing moved.
    const balanceAfter = await prisma.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    expect(balanceAfter.balance).toBe(CHECKING_BALANCE);
    expect(balanceAfter.balance).toBe(balanceBefore.balance);
    expect(await prisma.transaction.count()).toBe(txBefore);
    expect(await prisma.executionReceipt.count()).toBe(0);
    expect(await prisma.pendingAction.count()).toBe(0);
  });
});

describe('grounding — balance claims are checked against the server-authoritative accounts', () => {
  it('2a: an inflated available total is corrected to the real total', async () => {
    const runtime = scriptedRuntime([
      toolStep('get_balance', {}),
      fauxAssistantMessage('你的账户可用余额为 ¥999,999.99。'),
    ]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    // The authoritative server amount (the available total printed by `formatCNY`).
    expect(text).toContain('73,580.00');
    expect(text).not.toContain('999');
    expect(TOTAL_AVAILABLE).toBe(CHECKING_BALANCE + SAVINGS_BALANCE);
    // The wrong total was never streamed either.
    for (const delta of deltas(res.events)) expect(delta).not.toContain('999,999');
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });

  it('2b: the checking figure stated as the savings balance is corrected to the savings balance', async () => {
    const runtime = scriptedRuntime([
      toolStep('get_balance', {}),
      // The CHECKING number (¥23,580.00) wrongly attributed to the SAVINGS account.
      fauxAssistantMessage('储蓄余额为 ¥23,580.00。'),
    ]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    // The server renders BOTH actual accounts. Each amount must remain attached to its own account.
    expect(text).toContain('50,000.00');
    expect(text).toContain('储蓄账户');
    expect(text).toContain('活期账户当前余额为 ¥23,580.00');
    expect(text).toContain('储蓄账户当前余额为 ¥50,000.00');
    expect(text).not.toContain('储蓄余额为 ¥23,580.00');
    for (const delta of deltas(res.events)) expect(delta).not.toContain('储蓄余额为 ¥23,580.00');
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });
});

describe('grounding — a GREEN budget write is never conflated with a transfer success', () => {
  it('3: a reserve_budget success does not ground a TRANSFER completion claim', async () => {
    const prisma = getTestPrisma();
    const txBefore = await prisma.transaction.count();

    // A REAL GREEN write (reserve_budget auto-executes inline), then a false TRANSFER success claim.
    const runtime = scriptedRuntime([
      toolStep('reserve_budget', { name: '房租', amount: 500 }),
      fauxAssistantMessage(FALSE_SUCCESS),
    ]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '预留 500 作为房租预算，然后再转 500 给张伟。' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    // The reserve really happened — the Budget row exists for the demo user.
    const budget = await prisma.budget.findFirst({ where: { userId: DEMO_USER_ID, name: '房租' } });
    expect(budget).not.toBeNull();
    expect(budget!.amount).toBe(500);

    // A budget write must NOT be reported as a transfer success: the narration is corrected.
    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('转账已经成功完成');
    expect(text).toContain('预算预留处理结果');
    expect(text).toContain('金额 ¥500.00');
    expect(text).not.toContain('转账处理结果');

    // No transfer side effect: no new ledger row, no execution receipt.
    expect(await prisma.transaction.count()).toBe(txBefore);
    expect(await prisma.executionReceipt.count()).toBe(0);
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });
});

describe('grounding — the confirm continuation is grounded against the REAL injected result', () => {
  it('4: a contradictory continuation is replaced by the REAL recipient/amount', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    // The continuation invents 李华 / ¥30,000 — the REAL result is 张伟 / ¥200.00.
    const res = await resumeWith(
      sessionId,
      REAL_TRANSFER,
      '已向李华转账 ¥30,000.00，操作已完成。',
      toolCallId,
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    // The REAL structured outcome wins: recipient + amount come from the tool result, not the model.
    expect(text).toContain('张伟');
    expect(text).toContain('¥200.00');
    expect(text).not.toContain('李华');
    expect(text).not.toContain('30,000');
    // The false text was NEVER streamed.
    for (const delta of deltas(res.events)) {
      expect(delta).not.toContain('李华');
      expect(delta).not.toContain('30,000');
    }
    expect(await persistedAssistantText(sessionId)).toBe(text);
  });
});

describe('grounding — an UNKNOWN outcome may be asserted neither as success nor as failure', () => {
  it('5: both a success claim and a failure claim are corrected to the honest 待核对 state', async () => {
    // (a) a success claim about a write whose outcome needs reconciliation.
    const successPark = await parkYellowTransfer();
    const successRes = await resumeWith(
      successPark.sessionId,
      REAL_UNKNOWN_TRANSFER,
      '转账已成功完成。',
      successPark.toolCallId,
    );
    expect(errorMessages(successRes.events)).toEqual([]);
    const successText = finalAssistantText(successRes.events);
    expect(successText).toContain(CORRECTION_TAG);
    expect(successText).toContain('待核对');
    expect(successText).not.toContain('成功');
    expect(await persistedAssistantText(successPark.sessionId)).toBe(successText);

    // (b) a failure / "funds unchanged" claim about the SAME unknown outcome.
    const failurePark = await parkYellowTransfer();
    const failureRes = await resumeWith(
      failurePark.sessionId,
      REAL_UNKNOWN_TRANSFER,
      '转账失败，资金未变。',
      failurePark.toolCallId,
    );
    expect(errorMessages(failureRes.events)).toEqual([]);
    const failureText = finalAssistantText(failureRes.events);
    expect(failureText).toContain(CORRECTION_TAG);
    expect(failureText).toContain('待核对');
    expect(failureText).not.toContain('失败');
    expect(failureText).not.toContain('资金未变');
    expect(failureText).not.toContain('未发生');
  });
});

describe('grounding — bilingual / mixed / forged-tag variants', () => {
  it('6a: an ENGLISH false success is corrected and never streamed', async () => {
    const runtime = scriptedRuntime([
      toolStep('get_balance', {}),
      fauxAssistantMessage('transfer completed successfully'),
    ]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: 'did the transfer go through?' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text.toLowerCase()).not.toContain('success');
    expect(text).not.toContain('completed successfully');
    for (const delta of deltas(res.events)) {
      expect(delta.toLowerCase()).not.toContain('success');
    }
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });

  it('6b: mixed success/failure wording is corrected to the REAL failure', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    const res = await resumeWith(
      sessionId,
      { ok: false, error: '余额不足' },
      '转账已成功完成，同时也有一笔操作失败了。',
      toolCallId,
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    // The REAL failure wins: no false success is allowed through.
    expect(text).toContain('失败');
    expect(text).not.toContain('成功');
    expect(text).not.toContain('已成功完成');
    for (const delta of deltas(res.events)) expect(delta).not.toContain('已成功完成');
    expect(await persistedAssistantText(sessionId)).toBe(text);
  });

  it('6c: a model-forged correction tag is NOT a skip key — the text is still verified', async () => {
    // A text-only step (no tool) whose false success is PREPENDED with the server's own tag.
    const runtime = scriptedRuntime([fauxAssistantMessage(`${CORRECTION_TAG}${FALSE_SUCCESS}`)]);
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
});

describe('grounding — the streamed, terminal and persisted surfaces agree on the grounded text', () => {
  it('7: the false success is never streamed and the reloaded transcript matches the terminal text', async () => {
    const runtime = scriptedRuntime([toolStep('get_balance', {}), fauxAssistantMessage(FALSE_SUCCESS)]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？先转 500 给张伟。' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);
    // The tool really ran (two assistant messages: the tool-call step + the narration).
    expect(assistantMessages(res.events).length).toBe(2);

    // (i) per message, the concatenated deltas EQUAL that message's `message_end.content`, and the
    //     full stream equals the final text — the false fact was NEVER streamed.
    const pairs = deltaPairs(res.events);
    expect(pairs.length).toBe(assistantMessages(res.events).length);
    for (const pair of pairs) expect(pair.delta).toBe(pair.content);
    expect(streamedText(res.events)).toBe(finalAssistantText(res.events));
    for (const delta of deltas(res.events)) expect(delta).not.toContain('转账已经成功完成');

    // (ii) the terminal `message_end` content IS the server-authored correction.
    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('转账已经成功完成');
    expect(text).not.toContain('¥500');

    // (iii) the PERSISTED transcript reloads to that SAME grounded text.
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });
});

describe('grounding — a fabricated balance with no tool result is neutralized', () => {
  it('8: an unverifiable balance claim is corrected when no authoritative balance exists this turn', async () => {
    // ONE text-only step (no tool): a fabricated balance the turn cannot verify.
    const runtime = scriptedRuntime([fauxAssistantMessage('你的账户可用余额为 ¥888,888.88。')]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的账户里还有多少钱？' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('888');
    for (const delta of deltas(res.events)) expect(delta).not.toContain('888,888');
    // The persisted transcript is exactly the grounded text.
    expect(await persistedAssistantText(res.sessionId)).toBe(text);
  });
});

/* ==================================================================================================
 * MISSED-FACT / STALE-BALANCE / PER-OPERATION MAPPING
 *
 * The cases below pin three financial-fact-grounding defects through the SAME real pipeline (and the
 * same PURE decision): (a) a false financial fact that sits in ANOTHER clause than the operation verb,
 * carries no ¥/元 marker, or shares a message with a tool call is still corrected; (b) a write's
 * POST-write balance outranks the stale pre-write balance PER ACCOUNT (never a flat amount pool);
 * (c) the SAME tool executed twice maps EVERY claim to ITS OWN operation's real result.
 * Assertions pin the CORRECT (server-authoritative) behavior.
 * ================================================================================================== */

/** The REAL `get_balance` result shape (`BalanceView`): the seeded 活期 + 储蓄 accounts and total. */
const GET_BALANCE_RESULT: ToolExecutionResult = {
  ok: true,
  summary: '可用余额合计 ¥73,580.00，共 2 个账户：活期账户 ¥23,580.00、储蓄账户 ¥50,000.00。',
  data: {
    totalAvailable: TOTAL_AVAILABLE,
    currency: 'CNY',
    accounts: [
      {
        id: 'acct_checking',
        type: 'CHECKING',
        name: '活期账户',
        numberMasked: '****8821',
        balance: CHECKING_BALANCE,
        currency: 'CNY',
      },
      {
        id: 'acct_savings',
        type: 'SAVINGS',
        name: '储蓄账户',
        numberMasked: '****3309',
        balance: SAVINGS_BALANCE,
        currency: 'CNY',
      },
    ],
  },
};

/** The same REAL transfer but with a DIFFERENT post-write 活期 balance (guards 2a's authority). */
const REAL_TRANSFER_ALT_BALANCE: ToolExecutionResult = {
  ok: true,
  summary: '已向 张伟 转账 ¥200.00。',
  data: {
    amount: 200,
    newBalance: 23180,
    recipient: { name: '张伟', contactId: 'contact_zhangwei' },
  },
};

/** A REAL failed `transfer_money` (李华 / ¥5,000) carrying IDENTIFYING structured data. */
const FAILED_TRANSFER: ToolExecutionResult = {
  ok: false,
  error: 'INSUFFICIENT_FUNDS：账户余额不足。',
  data: { amount: 5000, recipient: { name: '李华', contactId: 'contact_lihua' } },
};

/** A REAL gated write whose outcome is UNKNOWN (needs reconciliation) — 李华 / ¥5,000. */
const UNKNOWN_TRANSFER_LIHUA: ToolExecutionResult = {
  ok: false,
  data: {
    amount: 5000,
    recipient: { name: '李华', contactId: 'contact_lihua' },
    needsReconciliation: true,
  },
};

/** Facts for the [query, then write] order: `get_balance` (pre-write) THEN the ¥200 transfer write. */
function queryThenWriteFacts(): ReturnType<typeof buildFinancialFacts> {
  return buildFinancialFacts([
    { toolName: 'get_balance', result: GET_BALANCE_RESULT },
    { toolName: 'transfer_money', result: REAL_TRANSFER },
  ]);
}

/** The false completion claim used across the per-operation mapping cases (李华 / ¥5,000). */
const CLAIM_PEER_TO_FAILURE = '已成功向李华转账 ¥5,000.00。';
/** The claim that matches its OWN successful operation (张伟 / ¥200). */
const CLAIM_PEER_TO_SUCCESS = '已成功向张伟转账 ¥200.00。';

describe('grounding — a MISSED financial fact is corrected to its own operation', () => {
  it('1a: a transfer claim whose amount/recipient sit in OTHER clauses is still corrected', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    // The transfer verb, the amount and the recipient live in THREE different comma-separated clauses.
    const res = await resumeWith(sessionId, REAL_TRANSFER, '转账成功，金额30000元，收款人李华。', toolCallId);
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    // The REAL structured outcome wins: recipient + amount come from the tool result, not the model.
    expect(text).toContain('张伟');
    expect(text).toContain('¥200.00');
    expect(text).not.toContain('李华');
    expect(text).not.toMatch(/30[,.]?000/);
    // The false text was NEVER streamed.
    for (const delta of deltas(res.events)) {
      expect(delta).not.toContain('李华');
      expect(delta).not.toMatch(/30[,.]?000/);
    }
    expect(await persistedAssistantText(sessionId)).toBe(text);
  });

  it('1b: a transfer claim with an UNMARKED amount (no ¥ / 元) is still corrected', async () => {
    const { sessionId, toolCallId } = await parkYellowTransfer();

    // The amount carries NO ¥ / 元 marker — but it is still a financial amount claim.
    const res = await resumeWith(sessionId, REAL_TRANSFER, '已成功向张伟转账30000。', toolCallId);
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).toContain('张伟');
    expect(text).toContain('¥200.00');
    expect(text).not.toMatch(/30[,.]?000/);
    for (const delta of deltas(res.events)) expect(delta).not.toMatch(/30[,.]?000/);
    expect(await persistedAssistantText(sessionId)).toBe(text);
  });

  it('1c: a fabricated receipt with NO tool result at all is corrected and moves no money', async () => {
    const prisma = getTestPrisma();
    const txBefore = await prisma.transaction.count();

    // ONE text-only step (no tool): the model claims a receipt it never verified.
    const runtime = scriptedRuntime([fauxAssistantMessage('张伟已经收到30000元。')]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '张伟收到钱了吗？' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);

    const text = finalAssistantText(res.events);
    expect(text).toContain(CORRECTION_TAG);
    expect(text).not.toContain('已经收到');
    expect(text).not.toMatch(/30[,.]?000/);
    for (const delta of deltas(res.events)) {
      expect(delta).not.toContain('已经收到');
      expect(delta).not.toMatch(/30[,.]?000/);
    }
    expect(await persistedAssistantText(res.sessionId)).toBe(text);

    // No side effect: the fabricated receipt is ungrounded and nothing moved.
    expect(await prisma.transaction.count()).toBe(txBefore);
    expect(await prisma.executionReceipt.count()).toBe(0);
  });

  it('1d: a message that ALSO carries a tool call is ground-checked too', async () => {
    // ONE message carries BOTH a real `get_balance` call AND a false financial fact in its text part.
    const runtime = scriptedRuntime([
      fauxAssistantMessage([fauxText(FALSE_SUCCESS), fauxToolCall('get_balance', {})], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('以上是本次查询的说明。'),
    ]);
    const res = await runTurn(
      { sessionId: newId('sess'), message: '我的余额是多少？' },
      { provider: runtime },
    );
    expect(errorMessages(res.events)).toEqual([]);
    // The tool-call step + the terminal narration.
    expect(assistantMessages(res.events).length).toBe(2);

    // The false fact is NEVER streamed, even though it shared a message with a tool call.
    for (const delta of deltas(res.events)) {
      expect(delta).not.toContain('转账已经成功完成');
      expect(delta).not.toContain('¥500');
    }
    // The tool-call-bearing message WAS ground-checked (a server correction is present).
    expect(assistantMessages(res.events).some((message) => message.content.includes(CORRECTION_TAG))).toBe(
      true,
    );
    // The persisted assistant transcript never carries the false claim either.
    const snapshot = await loadSession(res.sessionId);
    const persistedAssistant = snapshot!.transcript
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content);
    expect(persistedAssistant.length).toBe(2);
    expect(persistedAssistant.join(' ')).not.toContain('转账已经成功完成');

    // The reloaded last-assistant transcript equals the terminal content.
    expect(await persistedAssistantText(res.sessionId)).toBe(finalAssistantText(res.events));
  });
});

describe('grounding — the POST-WRITE balance outranks the stale pre-write balance', () => {
  it('2a: the post-write 活期 balance survives; the pre-write figure is NOT re-imposed', () => {
    const facts = queryThenWriteFacts();
    const correct = '当前活期账户余额为 ¥23,380.00。';
    // The write landed and moved the 活期 balance to ¥23,380 — the correct post-write figure survives.
    expect(groundAssistantText(correct, facts)).toBe(correct);

    // GUARD: without the write, ¥23,380 is NOT authoritative — the get_balance figure wins.
    const queryOnly = buildFinancialFacts([{ toolName: 'get_balance', result: GET_BALANCE_RESULT }]);
    expect(groundAssistantText(correct, queryOnly)).toContain(CORRECTION_TAG);

    // GUARD: authority comes from THIS write's `newBalance` — a different post-write balance corrects
    // the claim instead of accepting a coincidental figure.
    const otherWrite = buildFinancialFacts([
      { toolName: 'get_balance', result: GET_BALANCE_RESULT },
      { toolName: 'transfer_money', result: REAL_TRANSFER_ALT_BALANCE },
    ]);
    const corrected = groundAssistantText(correct, otherWrite);
    expect(corrected).toContain(CORRECTION_TAG);
    expect(corrected).not.toContain('23,380');
    const matching = '当前活期账户余额为 ¥23,180.00。';
    expect(groundAssistantText(matching, otherWrite)).toBe(matching);
  });

  it('2b: the stale pre-write 活期 balance is corrected to the post-write value', () => {
    const facts = queryThenWriteFacts();
    const stale = '当前活期账户余额为 ¥23,580.00。';
    const corrected = groundAssistantText(stale, facts);
    expect(corrected).toContain(CORRECTION_TAG);
    expect(corrected).toContain('23,380');
    expect(corrected).not.toContain('23,580');
  });

  it('2c: 活期 / 储蓄 / 信用 resolve PER ACCOUNT, never against a flat amount pool', () => {
    const facts = queryThenWriteFacts();

    // 储蓄 states its OWN figure — correct, survives byte-identical.
    const savingsOwn = '您的储蓄账户余额为 ¥50,000.00。';
    expect(groundAssistantText(savingsOwn, facts)).toBe(savingsOwn);

    // The SAVINGS figure claimed as the 活期 balance is NOT accepted via another account's balance.
    const savingsAsChecking = '您的活期账户余额为 ¥50,000.00。';
    const fixedSavings = groundAssistantText(savingsAsChecking, facts);
    expect(fixedSavings).toContain(CORRECTION_TAG);
    expect(fixedSavings).toContain('23,380');
    expect(fixedSavings).not.toContain('50,000');

    // The TOTAL claimed as the 活期 balance is likewise not accepted.
    const totalAsChecking = '您的活期账户余额为 ¥73,580.00。';
    const fixedTotal = groundAssistantText(totalAsChecking, facts);
    expect(fixedTotal).toContain(CORRECTION_TAG);
    expect(fixedTotal).toContain('23,380');
    expect(fixedTotal).not.toContain('73,580');

    // A 信用-labelled figure never inherits ANOTHER account's balance (no flat pool).
    const creditClaim = '您的信用账户可用余额为 ¥50,000.00。';
    const fixedCredit = groundAssistantText(creditClaim, facts);
    expect(fixedCredit).not.toBe(creditClaim);
    expect(fixedCredit).not.toContain('50,000');
  });
});

describe('grounding — the same tool executed twice maps EVERY claim to ITS OWN result', () => {
  it('3a: [success, failure] — a completion claim about the FAILED op is corrected to ITS OWN failure', () => {
    const facts = buildFinancialFacts([
      { toolName: 'transfer_money', result: REAL_TRANSFER },
      { toolName: 'transfer_money', result: FAILED_TRANSFER },
    ]);

    const failed = groundAssistantText(CLAIM_PEER_TO_FAILURE, facts);
    expect(failed).toContain(CORRECTION_TAG);
    expect(failed).toContain('实际执行失败');
    expect(failed).not.toContain('已成功');

    // The claim that matches ITS OWN success survives byte-identical.
    expect(groundAssistantText(CLAIM_PEER_TO_SUCCESS, facts)).toBe(CLAIM_PEER_TO_SUCCESS);
  });

  it('3b: [failure, success] — the reversed order maps each claim the same way', () => {
    const facts = buildFinancialFacts([
      { toolName: 'transfer_money', result: FAILED_TRANSFER },
      { toolName: 'transfer_money', result: REAL_TRANSFER },
    ]);

    const failed = groundAssistantText(CLAIM_PEER_TO_FAILURE, facts);
    expect(failed).toContain(CORRECTION_TAG);
    expect(failed).toContain('实际执行失败');
    expect(failed).not.toContain('已成功');

    expect(groundAssistantText(CLAIM_PEER_TO_SUCCESS, facts)).toBe(CLAIM_PEER_TO_SUCCESS);
  });

  it('3c: an UNKNOWN outcome among others renders 待核对 for ITS OWN claim', () => {
    const orders = [
      buildFinancialFacts([
        { toolName: 'transfer_money', result: REAL_TRANSFER },
        { toolName: 'transfer_money', result: UNKNOWN_TRANSFER_LIHUA },
      ]),
      buildFinancialFacts([
        { toolName: 'transfer_money', result: UNKNOWN_TRANSFER_LIHUA },
        { toolName: 'transfer_money', result: REAL_TRANSFER },
      ]),
    ];

    for (const facts of orders) {
      const unknown = groundAssistantText(CLAIM_PEER_TO_FAILURE, facts);
      expect(unknown).toContain(CORRECTION_TAG);
      expect(unknown).toContain('待核对');
      expect(unknown).not.toContain('成功');
      expect(unknown).not.toContain('失败');
      expect(unknown).not.toContain('资金未变');

      // The claim that matches ITS OWN success still survives.
      expect(groundAssistantText(CLAIM_PEER_TO_SUCCESS, facts)).toBe(CLAIM_PEER_TO_SUCCESS);
    }
  });
});
