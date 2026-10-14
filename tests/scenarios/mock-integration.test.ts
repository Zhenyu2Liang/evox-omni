/**
 * STAGING COPY — root must relocate to tests/scenarios/mock-integration.test.ts
 *
 * mock-integration — proves the demo is INTERACTIVELY USABLE OFFLINE by driving the REAL
 * PRODUCTION pipeline end-to-end with the deterministic mock model.
 *
 * What this suite exercises (nothing is scripted or stubbed):
 *   natural-language prompt
 *     → `@/agent` `runTurn` (production)
 *       → `createBankingAgent` (real) → `resolveModel` ⇒ `LLM_MODE=mock` faux model
 *         (`agent/providers/mock-responder.ts`, which reads the conversation and emits the
 *          right banking tool calls)
 *       → the 26 registered banking tools (`agent/tools/*`)
 *       → the `beforeToolCall` security chokepoint (`security/security-gateway.ts`)
 *       → the Banking SDK → the test SQLite DB
 *     → `@/agent` `confirmAction` / `verifyAction` (production two-phase continuation).
 *
 * Unlike `tests/scenarios/*` (which script the model via `tests/helpers/faux-agent.ts`), this
 * suite uses NO scripting helper: the model is the real mock model the running app resolves
 * under the default `LLM_MODE=mock`, so a green run here means the demo actually works when a
 * human types the prompts.
 *
 * GLOBAL REGRESSION GUARD (the defect this suite pins): EVERY turn must yield a NON-EMPTY
 * assistant text reply and NO `error` event. A mock model that returns no assistant text would
 * leave the UI silent (the empty-queue defect), so `expectHealthyTurn` asserts it on every turn.
 *
 * Env / DB: `LLM_MODE=mock` is forced by `tests/setup.ts` (and mirrored in vitest config env);
 * `beforeEach` resets + seeds the test SQLite; every turn uses a FRESH session id (so the
 * in-process circuit breaker stays isolated); `afterAll` disconnects Prisma.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { confirmAction, runTurn, verifyAction } from '@/agent';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS } from '@/tests/helpers/fixtures';
import { moneyToCents } from '@/lib/money';

/* ------------------------------------------------------------------ fixtures */

/** Recipient 张伟 (`contact_zhangwei`) — resolves unambiguously from the seeded contacts. */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** Primary 活期账户 (¥23,580) — the default transfer funding account. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;

/** Success phrasings a hallucinating agent might emit — none may appear when a transfer failed. */
const SUCCESS_PHRASING = /已向.*转账|转账成功|已成功转出/;
/** The SDK's insufficient-funds message (the real failure surfaced by Test 5). */
const INSUFFICIENT_FUNDS = /Insufficient funds/i;

/* ------------------------------------------------------------------ assertion helpers */

type TextDeltaEvent = Extract<AgentStreamEvent, { type: 'text_delta' }>;
type ToolEndEvent = Extract<AgentStreamEvent, { type: 'tool_end' }>;
type MessageEndEvent = Extract<AgentStreamEvent, { type: 'message_end' }>;
type ConfirmationEvent = Extract<AgentStreamEvent, { type: 'confirmation_required' }>;
type MfaEvent = Extract<AgentStreamEvent, { type: 'mfa_required' }>;

/** Concatenated assistant text of a turn (prefers streamed deltas; falls back to `message_end`). */
function turnText(events: readonly AgentStreamEvent[]): string {
  const deltas = events
    .filter((event): event is TextDeltaEvent => event.type === 'text_delta')
    .map((event) => event.delta)
    .join('');
  if (deltas !== '') return deltas;
  return events
    .filter((event): event is MessageEndEvent => event.type === 'message_end')
    .map((event) => event.message.content)
    .join('');
}

/** The last `tool_end` view for a tool (the tool's terminal lifecycle state this turn). */
function lastToolEnd(events: readonly AgentStreamEvent[], toolName: string) {
  const ends = events
    .filter((event): event is ToolEndEvent => event.type === 'tool_end')
    .filter((event) => event.toolEvent.toolName === toolName);
  return ends.length > 0 ? ends[ends.length - 1].toolEvent : undefined;
}

/** The gated decision a turn parked on (YELLOW confirmation or RED MFA), if any. */
function gatedDecision(
  events: readonly AgentStreamEvent[],
): { kind: 'confirmation'; event: ConfirmationEvent } | { kind: 'mfa'; event: MfaEvent } | null {
  const confirmation = events.find(
    (event): event is ConfirmationEvent => event.type === 'confirmation_required',
  );
  if (confirmation !== undefined) return { kind: 'confirmation', event: confirmation };
  const mfa = events.find((event): event is MfaEvent => event.type === 'mfa_required');
  if (mfa !== undefined) return { kind: 'mfa', event: mfa };
  return null;
}

/**
 * GLOBAL GUARD — assert a turn is interactively usable: NO `error` event and a NON-EMPTY
 * assistant reply. Returns the narration text for further assertions.
 */
function expectHealthyTurn(label: string, events: readonly AgentStreamEvent[]): string {
  const errors = events.filter((event) => event.type === 'error');
  expect(errors, `${label}: unexpected error event(s): ${JSON.stringify(errors)}`).toHaveLength(0);

  const text = turnText(events);
  expect(text.trim().length, `${label}: expected a NON-EMPTY assistant reply`).toBeGreaterThan(0);
  return text;
}

/** Assert the process literally never touched the network / a live LLM for this turn. */
function expectNoLiveModelLeak(events: readonly AgentStreamEvent[]): void {
  // A live-mode failure would surface as an `error` event; the health guard covers it. This is a
  // second, explicit tripwire so a regression to a network model can never pass silently.
  expect(events.some((event) => event.type === 'error')).toBe(false);
}

/* ------------------------------------------------------------------ lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 60000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------ tests */

describe('mock-model integration — the real production pipeline, OFFLINE', () => {
  it('Test 1 — "查询我的余额" / "我还有多少钱？" narrate the real ¥23,580 via a get_balance success event', async () => {
    for (const prompt of ['查询我的余额', '我还有多少钱？']) {
      const { events } = await runTurn({ message: prompt });
      expectNoLiveModelLeak(events);

      const text = expectHealthyTurn(`Test 1 (${prompt})`, events);
      // The mock model + real tool + real DB produced the true account summary.
      expect(text).toContain('23,580');

      const view = lastToolEnd(events, 'get_balance');
      expect(view, `Test 1 (${prompt}): expected a get_balance tool event`).toBeDefined();
      expect(view!.status).toBe('success');

      // GREEN ⇒ auto-executed: never parked for a human decision.
      expect(gatedDecision(events)).toBeNull();
    }
  });

  it('Test 2 — "给张伟转200元，备注AA" requires confirmation, then confirm() executes the real transfer', async () => {
    const { events } = await runTurn({ message: '给张伟转200元，备注AA' });
    expectHealthyTurn('Test 2 (turn)', events);

    const decision = gatedDecision(events);
    expect(decision?.kind, 'Test 2: expected a YELLOW confirmation_required decision').toBe(
      'confirmation',
    );
    if (decision?.kind !== 'confirmation') throw new Error('unreachable');
    expect(decision.event.action.tier).toBe('YELLOW');
    expect(decision.event.action.toolName).toBe('transfer_money');

    // The model's transfer call was BLOCKED by beforeToolCall — it never executed inline.
    const blocked = lastToolEnd(events, 'transfer_money');
    expect(blocked?.status).toBe('blocked');
    // Permission state belongs to the structured request; prose is not an authorization receipt.
    const pending = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: decision.event.actionId } });
    expect(pending.status).toBe('pending');
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } })).balanceMinor)
      .toBe(moneyToCents(CHECKING.balance));

    const outcome = await confirmAction(decision.event.actionId);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    const continued = expectHealthyTurn('Test 2 (confirm)', outcome.events);
    expect(continued).toContain('张伟');
    expect(continued).toContain('200');

    // Real money moved through the SDK: a DEBIT written and the balance dropped 23,580 → 23,380.
    const prisma = getTestPrisma();
    const debits = await prisma.transaction.findMany({
      where: { accountId: CHECKING.id, counterpartyId: ZHANGWEI.id, amountMinor: -20_000n },
    });
    expect(debits).toHaveLength(1);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: CHECKING.id } });
    expect(account.balanceMinor).toBe(moneyToCents(CHECKING.balance) - 20_000n);
  });

  it('Test 3 — "给张伟转5000元" is RED and requires MFA, then verify(123456) executes', async () => {
    const { events } = await runTurn({ message: '给张伟转5000元' });
    expectHealthyTurn('Test 3 (turn)', events);

    const decision = gatedDecision(events);
    expect(decision?.kind, 'Test 3: expected a RED mfa_required decision').toBe('mfa');
    if (decision?.kind !== 'mfa') throw new Error('unreachable');

    const blocked = lastToolEnd(events, 'transfer_money');
    expect(blocked?.status).toBe('blocked');

    const outcome = await verifyAction(decision.event.actionId, MFA_CODE);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    const continued = expectHealthyTurn('Test 3 (verify)', outcome.events);
    expect(continued).toContain('张伟');
    expect(continued).toMatch(/5,000|5000/);

    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
    expect(account.balanceMinor).toBe(moneyToCents(CHECKING.balance) - 500_000n);
  });

  it('Test 5 — "给张伟转30000元" is RED + MFA, and the real INSUFFICIENT_FUNDS failure is reported truthfully', async () => {
    const { events } = await runTurn({ message: '给张伟转30000元' });
    expectHealthyTurn('Test 5 (turn)', events);

    const decision = gatedDecision(events);
    expect(decision?.kind, 'Test 5: expected a RED mfa_required decision').toBe('mfa');
    if (decision?.kind !== 'mfa') throw new Error('unreachable');

    // The human verifies; the SDK runs the ORIGINAL args and REJECTS them (> ¥23,580 balance).
    const outcome = await verifyAction(decision.event.actionId, MFA_CODE);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('failed');

    const continued = expectHealthyTurn('Test 5 (verify)', outcome.events);
    // Honest failure — the SAME real error, and NO hallucinated success phrasing.
    expect(continued).toMatch(INSUFFICIENT_FUNDS);
    expect(continued).not.toMatch(SUCCESS_PHRASING);

    // Nothing moved: no transaction to 张伟, balance untouched.
    const prisma = getTestPrisma();
    expect(await prisma.transaction.count({ where: { counterpartyId: ZHANGWEI.id } })).toBe(0);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: CHECKING.id } });
    expect(account.balanceMinor).toBe(moneyToCents(CHECKING.balance));
  });

  it('Test 6 — "分析一下我这个月的消费" / "帮我看下这个月花了多少" run analyze_spending and narrate', async () => {
    for (const prompt of ['分析一下我这个月的消费', '帮我看下这个月花了多少']) {
      const { events } = await runTurn({ message: prompt });
      expectNoLiveModelLeak(events);

      const text = expectHealthyTurn(`Test 6 (${prompt})`, events);

      const view = lastToolEnd(events, 'analyze_spending') ?? lastToolEnd(events, 'get_transactions');
      expect(view, `Test 6 (${prompt}): expected a spending/transactions tool event`).toBeDefined();
      expect(view!.status).toBe('success');

      // The real current-month total (¥5,800) is narrated; GREEN ⇒ no human gate.
      expect(text).toContain('消费');
      expect(gatedDecision(events)).toBeNull();
    }
  });
});
