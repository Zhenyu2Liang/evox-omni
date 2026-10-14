/**
 * tests/app/nl-entry-http.test.ts — REAL-application-entry (HTTP) e2e for NATURAL-LANGUAGE entry.
 *
 * These specs drive the REAL Next.js route handlers through their exported `POST` functions with
 * REAL `NextRequest` objects (see `./harness.ts`): `POST /api/chat` FIRST (a Chinese NL request is
 * classified by the deterministic mock responder and the gated tool call is PARKED by the security
 * gateway), then the human-decision routes `POST /api/actions/[id]/{confirm,verify}` COMPLETE it.
 * The whole production stack runs underneath — route → `@/agent` `runTurn`/`confirmAction` →
 * banking tools → security gateway `beforeToolCall` → Banking SDK → the test SQLite. Only the MODEL
 * is scripted: `tests/setup.ts` forces `LLM_MODE=mock` (`agent/providers/mock-responder.ts`).
 * Offline, no API key, no network.
 *
 * The point of this suite is the NL ENTRY POINT: prove that phrasing a request in ordinary Chinese
 * (no tool names, no ids) still routes to the correct gated tool, and that money-/state-moving calls
 * only ever complete through a human confirm/verify — never from model text. Each gated trigger is
 * cross-checked against the exact keyword in `agent/providers/mock-responder.ts`:
 *   - "把信用卡娱乐限额调整到1500" → YELLOW `set_card_limit` (classifySetCardLimit);
 *   - "申购稳健理财A 1000元"      → RED    `subscribe_investment` (classifySubscribeInvestment);
 *   - "取消Netflix订阅"           → YELLOW `cancel_subscription` (classifyCancelSubscription);
 *   - "我要转账"                  → NO tool call, a CLARIFICATION asking for the missing fields
 *                                    (handleTransfer with no recipient/amount ⇒ plain()).
 *
 * DB lifecycle matches the other DB-backed suites: reset + seed before each test, disconnect after.
 * Every parking turn uses a FRESH session id (the in-process circuit breaker is keyed by
 * `sessionId`); the persisted id is the one the route returns, so that is what we assert on.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import type { AgentStreamEvent, ChatTurnResponse } from '@/lib/contracts/agent';
import { MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS } from '@/tests/helpers/fixtures';
import { actionUrl, chatUrl, idCtx, postJson, type HttpResult } from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/** The primary 活期账户 (¥23,580) — the default funding account a RED subscribe debits. */
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;
/** The seeded checking balance (¥23,580). */
import { centsToMoney, moneyToCents, normalizeMoney, subtractMoney } from '@/lib/money';
const SEEDED_BALANCE = normalizeMoney(CHECKING.balance);
/** Recipient 张伟 — the actor of the (never-taken) transfer clarification probe. */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;

/** Seeded credit card + its 娱乐 category (the card limit a YELLOW `set_card_limit` replaces). */
const CREDIT_CARD_ID = 'card_credit';
const ENTERTAINMENT_CATEGORY = '娱乐';
/** The seeded 娱乐 limit (fixtures CARD_LIMITS) — it must change 3000 → 1500 after the confirm. */
const SEEDED_ENT_LIMIT = '3000';
/** The NL request targets ¥1500. */
const NEW_ENT_LIMIT = '1500';

/** Seeded 稳健理财A (R2, ¥1,000 min) — the product a RED `subscribe_investment` buys into. */
const PRODUCT_ID = 'prod_wenjiana';
/** The subscribe amount in the NL request. */
const SUBSCRIBE_AMOUNT = '1000';
/** The seeded holding count for 稳健理财A (fixtures buildHoldings ships exactly one). */
const SEEDED_HOLDINGS = 1;

/** Seeded Netflix subscription — the subscription a YELLOW `cancel_subscription` cancels. */
const NETFLIX_ID = 'sub_netflix';

/**
 * The route's JSON envelope — the transport shape (NOT a frozen `@/lib/contracts` type). Declared
 * structurally only so specs can narrow `ok`/`data`/`error` without importing app-private modules.
 */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/* -------------------------------------------------------------------------- envelope helpers */

/** Success protocol helper: assert the envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/* -------------------------------------------------------------------------- event narrowing */

type ToolEndEvent = Extract<AgentStreamEvent, { type: 'tool_end' }>;
type ToolStartEvent = Extract<AgentStreamEvent, { type: 'tool_start' }>;
type MessageEndEvent = Extract<AgentStreamEvent, { type: 'message_end' }>;
type ConfirmationEvent = Extract<AgentStreamEvent, { type: 'confirmation_required' }>;
type MfaEvent = Extract<AgentStreamEvent, { type: 'mfa_required' }>;

function lastToolEnd(
  events: readonly AgentStreamEvent[],
  name: string,
): ToolEndEvent['toolEvent'] | undefined {
  const ends = events.filter(
    (event): event is ToolEndEvent => event.type === 'tool_end' && event.toolEvent.toolName === name,
  );
  return ends.length > 0 ? ends[ends.length - 1].toolEvent : undefined;
}

function toolStarts(events: readonly AgentStreamEvent[]): ToolStartEvent[] {
  return events.filter((event): event is ToolStartEvent => event.type === 'tool_start');
}

function toolEnds(events: readonly AgentStreamEvent[]): ToolEndEvent[] {
  return events.filter((event): event is ToolEndEvent => event.type === 'tool_end');
}

function confirmationOf(events: readonly AgentStreamEvent[]): ConfirmationEvent | undefined {
  return events.find((event): event is ConfirmationEvent => event.type === 'confirmation_required');
}

function mfaOf(events: readonly AgentStreamEvent[]): MfaEvent | undefined {
  return events.find((event): event is MfaEvent => event.type === 'mfa_required');
}

/** The final assistant reply text of the turn (the last `message_end` message content). */
function assistantText(events: readonly AgentStreamEvent[]): string {
  const ends = events.filter(
    (event): event is MessageEndEvent => event.type === 'message_end',
  );
  return ends.length > 0 ? ends[ends.length - 1].message.content : '';
}

/* -------------------------------------------------------------------------------- invokers */

/** Drive one JSON-mode NL turn against the REAL chat route (fresh session). */
async function chatTurn(message: string): Promise<ChatTurnResponse> {
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({ stream: 0 }), {
    message,
  });
  expect(res.status).toBe(200);
  return payload(res);
}

/** The single `PendingAction` the parking turn persisted for `sessionId`. */
function parked(sessionId: string) {
  return getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId } });
}

/**
 * Invoke a real action route handler. The dynamic-route `ctx` MUST be passed explicitly (the harness
 * defaults it to `idCtx('')`), and `sessionId` travels as the `banking_session` COOKIE — identity is
 * cookie-only, so a `?sessionId=` query param would be IGNORED.
 */
function confirmAction(id: string, sessionId?: string): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(confirmPost, actionUrl(id, 'confirm'), {}, {
    ctx: idCtx(id),
    sessionId,
  });
}

function verifyAction(
  id: string,
  code: string,
  sessionId?: string,
): Promise<HttpResult<Envelope<ActionResponse>>> {
  return postJson<Envelope<ActionResponse>>(verifyPost, actionUrl(id, 'verify'), { code }, {
    ctx: idCtx(id),
    sessionId,
  });
}

/* ----------------------------------------------------------------------------- DB helpers */

/** Current 活期 balance (¥23,580 seeded). */
async function checkingBalance(): Promise<string> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return centsToMoney(account.balanceMinor);
}

/** Every ledger row paid to 张伟 (the money-moved probe for the clarification turn). */
function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** Holdings of 稳健理财A (seeded = 1; a RED subscribe creates a second one). */
function holdingsOfProduct() {
  return getTestPrisma().investmentHolding.findMany({ where: { productId: PRODUCT_ID } });
}

/* ------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ----------------------------------------------------------------------------------- tests */

describe('[integration] POST /api/chat NL → YELLOW set_card_limit → POST /api/actions/[id]/confirm', () => {
  it('1 — "把信用卡娱乐限额调整到1500" parks a YELLOW gate, confirm replaces the 娱乐 limit 3000 → 1500', async () => {
    const turn = await chatTurn('把信用卡娱乐限额调整到1500');
    const events = turn.events;

    // The NL request routed to the gated `set_card_limit` tool and the gateway BLOCKED it.
    expect(lastToolEnd(events, 'set_card_limit')?.status).toBe('blocked');
    expect(confirmationOf(events), 'expected a YELLOW confirmation_required event').toBeDefined();
    expect(mfaOf(events), 'YELLOW never requires MFA').toBeUndefined();
    expect(events[events.length - 1]).toEqual({ type: 'done' });

    const confirmation = confirmationOf(events)!;
    expect(confirmation.action.tier).toBe('YELLOW');
    expect(confirmation.action.toolName).toBe('set_card_limit');
    expect(confirmation.action.requiresMfa).toBe(false);

    // A pendingAction row was persisted for THIS session, still awaiting the human decision.
    const row = await parked(turn.sessionId);
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.requiresMfa).toBe(false);
    expect(row.status).toBe('pending');
    expect(row.toolName).toBe('set_card_limit');
    expect(confirmation.actionId).toBe(row.id);

    // Before the confirm the seeded 娱乐 limit on the credit card is ¥3,000 — nothing has changed.
    const before = await getTestPrisma().cardLimit.findMany({
      where: { cardId: CREDIT_CARD_ID, category: ENTERTAINMENT_CATEGORY },
    });
    expect(before).toHaveLength(1);
    expect(before[0].amountMinor).toBe(moneyToCents(SEEDED_ENT_LIMIT));

    // The human confirm executes the ORIGINAL validated args (娱乐 → ¥1500) exactly once.
    const res = await confirmAction(row.id, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('YELLOW');
    expect(data.actionId).toBe(row.id);
    expect(data.sessionId).toBe(turn.sessionId);

    // `setCardLimit` uses REPLACE semantics (delete-then-create): exactly ONE row, now ¥1,500.
    const after = await getTestPrisma().cardLimit.findMany({
      where: { cardId: CREDIT_CARD_ID, category: ENTERTAINMENT_CATEGORY },
    });
    expect(after).toHaveLength(1);
    expect(after[0].amountMinor).toBe(moneyToCents(NEW_ENT_LIMIT));
  });
});

describe('[integration] POST /api/chat NL → RED subscribe_investment → POST /api/actions/[id]/verify', () => {
  it('2 — "申购稳健理财A 1000元" parks a RED gate, verify(MFA_CODE) creates the holding and debits ¥1000', async () => {
    const turn = await chatTurn('申购稳健理财A 1000元');
    const events = turn.events;

    // The NL request routed to the gated `subscribe_investment` tool and the gateway BLOCKED it.
    expect(lastToolEnd(events, 'subscribe_investment')?.status).toBe('blocked');
    expect(mfaOf(events), 'expected a RED mfa_required event').toBeDefined();
    expect(confirmationOf(events), 'RED parks for MFA, not plain confirmation').toBeUndefined();
    expect(events[events.length - 1]).toEqual({ type: 'done' });

    const mfa = mfaOf(events)!;
    expect(mfa.actionId.length).toBeGreaterThan(0);

    // A pendingAction row was persisted as awaiting_mfa for THIS session.
    const row = await parked(turn.sessionId);
    expect(row.riskLevel).toBe('RED');
    expect(row.requiresMfa).toBe(true);
    expect(row.status).toBe('awaiting_mfa');
    expect(row.toolName).toBe('subscribe_investment');
    expect(mfa.actionId).toBe(row.id);

    // Nothing has executed yet: the seeded holding is the only one and no money has moved.
    expect(await holdingsOfProduct()).toHaveLength(SEEDED_HOLDINGS);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);

    // The human verify with the mock MFA code executes the ORIGINAL args (稳健理财A ¥1000).
    const res = await verifyAction(row.id, MFA_CODE, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('RED');
    expect(data.mfaResult).toBe('success');
    expect(data.actionId).toBe(row.id);

    // A NEW holding for 稳健理财A was created (1 → 2) and the checking account was debited by ¥1000.
    const holdings = await holdingsOfProduct();
    expect(holdings).toHaveLength(SEEDED_HOLDINGS + 1);
    expect(
      holdings.some((holding) => holding.principalAmountMinor === moneyToCents(SUBSCRIBE_AMOUNT) && holding.status === 'HOLDING'),
      'expected the newly-created HOLDING to carry the requested amount',
    ).toBe(true);
    expect(await checkingBalance()).toBe(subtractMoney(SEEDED_BALANCE, SUBSCRIBE_AMOUNT));
  });
});

describe('[integration] POST /api/chat NL → YELLOW cancel_subscription → POST /api/actions/[id]/confirm', () => {
  it('3 — "取消Netflix订阅" parks a YELLOW gate, confirm flips the Netflix subscription to CANCELLED', async () => {
    const turn = await chatTurn('取消Netflix订阅');
    const lookup = confirmationOf(turn.events);
    expect(lookup?.action.toolName).toBe('list_subscriptions');
    const read = payload(await confirmAction(lookup!.actionId, turn.sessionId));
    const events = read.events;

    // Confirming a prerequisite read can propose the declared cancellation, but cannot execute it.
    expect(lastToolEnd(events, 'cancel_subscription')?.status).toBe('blocked');
    expect(confirmationOf(events), 'expected a YELLOW confirmation_required event').toBeDefined();
    expect(mfaOf(events), 'YELLOW never requires MFA').toBeUndefined();
    expect(events[events.length - 1]).toEqual({ type: 'done' });

    const confirmation = confirmationOf(events)!;
    expect(confirmation.action.tier).toBe('YELLOW');
    expect(confirmation.action.toolName).toBe('cancel_subscription');

    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: confirmation.actionId } });
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.requiresMfa).toBe(false);
    expect(row.status).toBe('pending');
    expect(row.toolName).toBe('cancel_subscription');
    expect(confirmation.actionId).toBe(row.id);

    // Before the confirm the Netflix subscription is still ACTIVE.
    const before = await getTestPrisma().subscription.findUniqueOrThrow({ where: { id: NETFLIX_ID } });
    expect(before.name).toBe('Netflix');
    expect(before.status).toBe('ACTIVE');

    // The human confirm executes the ORIGINAL validated args (cancel sub_netflix).
    const res = await confirmAction(row.id, turn.sessionId);
    expect(res.status).toBe(200);
    const data = payload(res);
    expect(data.ok).toBe(true);
    expect(data.status).toBe('executed');
    expect(data.tier).toBe('YELLOW');
    expect(data.actionId).toBe(row.id);

    const after = await getTestPrisma().subscription.findUniqueOrThrow({ where: { id: NETFLIX_ID } });
    expect(after.status).toBe('CANCELLED');
  });
});

describe('[integration] POST /api/chat — MISSING info ⇒ CLARIFICATION (no tool call, no money, no park)', () => {
  it('4 — "我要转账" performs NO tool call, parks NOTHING, moves NO money, and ASKS for the missing fields', async () => {
    const turn = await chatTurn('我要转账');
    const events = turn.events;

    // No tool ever runs: the model asks a clarifying question instead of proposing a call.
    expect(toolStarts(events)).toHaveLength(0);
    expect(toolEnds(events)).toHaveLength(0);
    expect(confirmationOf(events)).toBeUndefined();
    expect(mfaOf(events)).toBeUndefined();
    expect(events[events.length - 1]).toEqual({ type: 'done' });

    // Nothing was parked, no money moved and no ledger row was written.
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);

    // The assistant text ASKS for the missing recipient/amount (mock-responder `handleTransfer`).
    const text = assistantText(events);
    expect(text, 'expected a clarification asking for the transfer recipient').toContain('转给谁');
  });

  it('4b — "给张伟转账" (recipient known, amount missing) still asks instead of calling transfer_money', async () => {
    const turn = await chatTurn('给张伟转账');
    const events = turn.events;

    expect(toolStarts(events)).toHaveLength(0);
    expect(toolEnds(events)).toHaveLength(0);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_BALANCE);
    expect(await zhangweiTransfers()).toHaveLength(0);

    // The model asks only for the missing amount; the original recipient remains in context.
    const text = assistantText(events);
    expect(text).toContain('多少钱');
  });
});
