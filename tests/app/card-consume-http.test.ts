/**
 * tests/app/card-consume-http.test.ts — HTTP acceptance for the virtual-card CONSUME surface.
 *
 * These specs drive the REAL Next.js route handlers in-process (no browser, no mock pipeline):
 *   - `POST /api/cards/[id]/consume`  → `POST` from `app/api/cards/[id]/consume/route.ts`
 *   - `GET  /api/cards/[id]/consumptions` → `GET` from `app/api/cards/[id]/consumptions/route.ts`
 *
 * `tests/setup.ts` forces `LLM_MODE=mock` and the isolated `prisma/test.db`, so the whole
 * route → `@/banking-sdk` → SQLite stack runs offline. Only the card-consumption feature is
 * exercised here; identity is resolved SERVER-SIDE (`_lib/session#resolveUserId`), so a
 * client-supplied cookie/session hint can never name the owner.
 *
 * The seed ships NO account-bound card (both seeded cards are unbound), so every spec first ISSUES
 * a VIRTUAL card through the real SDK (`banking.card.applyVirtualCard`, bound to `acct_checking`)
 * and then drives the HTTP surface against it. Money is asserted as exact canonical CNY decimal
 * strings / integer minor units — never floats.
 *
 * NOTE: `CardConsumption` declares no relations, so the shared `truncateAll()` (written before this
 * ledger existed) does NOT clear it; the suite truncates it in `beforeEach` so every test starts
 * from a genuinely empty spend history.
 *
 * NOTE: the consumption INSTANT is SERVER-OWNED. The body has no time parameter and a body that
 * CONTAINS an `occurredAt` key is refused with `400 VALIDATION` before any delegation (see the
 * `server-owned booking time` block at the bottom); the SDK books every accepted spend at
 * `demoNow()`. Because `demoNow()` is the PINNED `DEMO_NOW`, two route-created rows carry the SAME
 * `occurredAt`, and `CardConsumption.createdAt` is second-precision SQLite `CURRENT_TIMESTAMP` — so
 * the ORDERING / `?limit=` specs seed their instants directly (`seedConsumption`) instead of trying
 * to order route-created rows.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { CardConsumptionView, ConsumeCardResult } from '@/banking-sdk/types';
import { POST as consumePost } from '@/app/api/cards/[id]/consume/route';
import { GET as consumptionsGet } from '@/app/api/cards/[id]/consumptions/route';
import { demoMonthRange, demoNow, demoPreviousMonthRange } from '@/lib/clock';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { getJson, idCtx, postJson } from './harness';

/** The user's default CHECKING account (¥23,580) — the settlement account every issued card binds. */
const CHECKING = 'acct_checking';
/** A SAVINGS account — never a valid virtual-card settlement account. */
const SAVINGS = 'acct_savings';
/** Unique merchant label so the created ledger row can be isolated from the seeded CARD history. */
const DETAILS = 'HTTPSPEC虚拟卡消费';
/** The seeded checking balance, ¥23,580.00 in exact minor units. */
const CHECKING_MINOR = 2358000n;
/** A user that owns none of the demo data — proves the ownership fence. */
const FOREIGN_USER = 'user_other';
const FOREIGN_CARD = 'card_foreign';

const db = () => getTestPrisma();

/** Loose reading view of the frozen HTTP envelope (`{ ok, data } | { ok, error }`) for assertions. */
interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string } }
beforeEach(resetDatabase);
/** `truncateAll()` predates the relation-free `CardConsumption` ledger, so clear it on the fresh world. */
beforeEach(async () => {
  await db().cardConsumption.deleteMany();
});
afterAll(disconnectTestPrisma);

/** Issue an ACTIVE virtual card bound to `acct_checking` (omitted limit ⇒ unlimited monthly spend). */
async function issueVirtual(monthlyLimit?: string): Promise<{ id: string }> {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit, linkedAccountId: CHECKING });
}

/** Insert a card (and its owner) that belongs to a DIFFERENT user — its spend must be invisible. */
async function seedForeignCard(): Promise<string> {
  await db().user.create({ data: { id: FOREIGN_USER, name: 'Other owner', phone: '13900003344' } });
  await db().card.create({ data: {
    id: FOREIGN_CARD, userId: FOREIGN_USER, type: 'VIRTUAL', network: 'UnionPay',
    numberMasked: '****0001', status: 'ACTIVE', linkedAccountId: null,
  } });
  return FOREIGN_CARD;
}

function consumePath(cardId: string): string {
  return `/api/cards/${encodeURIComponent(cardId)}/consume`;
}

function consumptionsPath(cardId: string, query = ''): string {
  return `/api/cards/${encodeURIComponent(cardId)}/consumptions${query}`;
}

/** POST a consume request for `cardId`, forwarding only the ignored browser identity hints. */
function consume(cardId: string, body: unknown, opts: { sessionId?: string; cookie?: string } = {}) {
  return postJson<Envelope<ConsumeCardResult>>(consumePost, consumePath(cardId), body, {
    ctx: idCtx(cardId),
    ...opts,
  });
}

/** GET the consumption ledger for `cardId`, forwarding only the ignored browser identity hints. */
function consumeList(cardId: string, query = '', opts: { sessionId?: string; cookie?: string } = {}) {
  return getJson<Envelope<{ consumptions: CardConsumptionView[] }>>(
    consumptionsGet,
    consumptionsPath(cardId, query),
    { ctx: idCtx(cardId), ...opts },
  );
}

/** The durable money state a card refusal must never disturb. */
async function ledgerState() {
  return {
    consumptionCount: await db().cardConsumption.count(),
    transactionCount: await db().transaction.count(),
    checkingBalanceMinor: (await db().account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor,
  };
}

/** Assert an exact domain refusal status + code AND that no spend was persisted. */
async function expectRefused(cardId: string, body: unknown, code: string, status: number): Promise<void> {
  const before = await ledgerState();
  const res = await consume(cardId, body);
  expect(res.status).toBe(status);
  expect(res.data).toMatchObject({ ok: false, error: { code } });
  expect(await ledgerState()).toEqual(before);
}

/**
 * Assert the SERVER-OWNED-TIME refusal and that it had NO side effect.
 *
 * The refusal must be machine-checkable, not just a status: `VALIDATION` plus a message that names
 * the server-owned booking time and the offending key, so a UI can surface why the write was
 * rejected. Nothing may move — same balance, same ledger row count, same consumption row count.
 */
async function expectTimeRefused(cardId: string, body: Record<string, unknown>): Promise<void> {
  const before = await ledgerState();
  const res = await consume(cardId, body);
  expect(res.status).toBe(400);
  expect(res.data?.ok).toBe(false);
  expect(res.data?.error?.code).toBe('VALIDATION');
  expect(res.data?.error?.message).toMatch(/server-owned/i);
  expect(res.data?.error?.message).toContain("'occurredAt'");
  expect(await ledgerState()).toEqual(before);
}

/**
 * Seed ONE `CardConsumption` row DIRECTLY on the ledger with an explicit `occurredAt`.
 *
 * WHY the specs below cannot use the consume route for this: the booking instant is SERVER-OWNED,
 * so `demoNow()` (the pinned `DEMO_NOW`) gives every route-created row the SAME `occurredAt`, and
 * `CardConsumption.createdAt` is SQLite `DEFAULT CURRENT_TIMESTAMP` (SECOND precision) — two rows
 * created in the same second therefore have no deterministic relative order. Distinct explicit
 * instants keep the ordering / `?limit=` assertions deterministic; the consume → list integration
 * path stays covered by a real POST in the ordering spec.
 */
async function seedConsumption(
  cardId: string,
  args: { amountMinor: bigint; occurredAt: number; merchant?: string; userId?: string },
): Promise<void> {
  await db().cardConsumption.create({ data: {
    cardId,
    accountId: CHECKING,
    userId: args.userId ?? DEMO_USER_ID,
    amountMinor: args.amountMinor,
    currency: 'CNY',
    category: '其他',
    merchant: args.merchant ?? DETAILS,
    occurredAt: new Date(args.occurredAt),
    executionKey: null,
  } });
}

/** SUM of the card's consumption magnitudes booked INSIDE the current demo month (exact minor units). */
async function currentMonthSpendMinor(cardId: string): Promise<bigint> {
  const { start, end } = demoMonthRange();
  const rows = await db().cardConsumption.findMany({ where: { cardId, occurredAt: { gte: start, lt: end } } });
  return rows.reduce((sum, row) => sum + row.amountMinor, 0n);
}

describe('POST /api/cards/[id]/consume', () => {
  it('debits the bound account and persists a CARD ledger row plus a CardConsumption', async () => {
    const card = await issueVirtual('5000.00');
    const before = await ledgerState();
    // The booking instant is SERVER-OWNED, so the request carries NO time (sending `occurredAt` at
    // all is refused — see the date-tampering block). It is asserted where it lives: the view/reply
    // reports epoch ms, the persisted row a `Date`.
    const bookedAt = demoNow();

    const res = await consume(card.id, { amount: '88.50', category: '餐饮', merchant: DETAILS });

    expect(res.status).toBe(200);
    expect(res.data?.ok).toBe(true);
    const result = res.data!.data!;
    expect(result.consumption).toMatchObject({
      cardId: card.id, accountId: CHECKING, amount: '88.50', currency: 'CNY',
      category: '餐饮', merchant: DETAILS, occurredAt: bookedAt,
    });
    expect(result.consumption.executionKey).toBeUndefined();
    expect(result.accountAvailableBalance).toBe('23491.50');
    expect(result.card).toMatchObject({ id: card.id, type: 'VIRTUAL', status: 'ACTIVE', accountAvailableBalance: '23491.50' });

    // The server instant is the demo clock and lies INSIDE the current demo month (half-open range),
    // so the spend is attributed to the month the server is in — never to a client-chosen one.
    const month = demoMonthRange();
    expect(bookedAt).toBeGreaterThanOrEqual(month.start.getTime());
    expect(bookedAt).toBeLessThan(month.end.getTime());

    // The ledger row is a DEBIT on the bound account, channelled CARD, owned by the server user.
    const ledger = await db().transaction.findMany({ where: { merchant: DETAILS } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      userId: DEMO_USER_ID, accountId: CHECKING, channel: 'CARD', direction: 'DEBIT',
      category: '餐饮', merchant: DETAILS, currency: 'CNY', amountMinor: -8850n,
      occurredAt: new Date(bookedAt),
    });
    const consumption = await db().cardConsumption.findMany({ where: { cardId: card.id } });
    expect(consumption).toHaveLength(1);
    expect(consumption[0]).toMatchObject({
      userId: DEMO_USER_ID, accountId: CHECKING, amountMinor: 8850n, currency: 'CNY',
      category: '餐饮', merchant: DETAILS, executionKey: null,
    });
    expect(consumption[0].occurredAt).toEqual(new Date(bookedAt));

    const after = await ledgerState();
    expect(after.consumptionCount).toBe(before.consumptionCount + 1);
    expect(after.transactionCount).toBe(before.transactionCount + 1);
    expect(after.checkingBalanceMinor).toBe(CHECKING_MINOR - 8850n);
  });

  it('replays a same-executionKey consume without a second charge', async () => {
    const card = await issueVirtual('5000.00');
    // Again server-booked: the body carries no time, only the replay identity.
    const body = { amount: '12.34', category: '餐饮', merchant: DETAILS, executionKey: 'http-consume-key-1' };

    const first = await consume(card.id, body);
    const second = await consume(card.id, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.data?.data).toEqual(first.data?.data);
    expect(first.data?.data?.consumption.occurredAt).toBe(demoNow());
    expect(second.data?.data?.consumption.executionKey).toBe('http-consume-key-1');
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(1);
    expect(await db().transaction.count({ where: { merchant: DETAILS } })).toBe(1);
    expect((await db().account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor).toBe(CHECKING_MINOR - 1234n);
  });

  it('ignores a client-supplied identity hint and always spends as the server-resolved user', async () => {
    const card = await issueVirtual('5000.00');

    const res = await consume(card.id, { amount: '10.00', merchant: DETAILS }, { sessionId: 'foreign-workspace' });

    expect(res.status).toBe(200);
    expect((await db().cardConsumption.findMany({ where: { cardId: card.id } })).map((row) => row.userId)).toEqual([DEMO_USER_ID]);
    expect(await db().cardConsumption.count({ where: { userId: 'foreign-workspace' } })).toBe(0);
  });

  it.each([
    ['an unknown card', 'card_missing', 404, 'NOT_FOUND'],
    ['an unbound seeded card', 'card_credit', 409, 'CONFLICT'],
  ] as const)('refuses %s with no persisted spend', async (_label, cardId, status, code) => {
    await expectRefused(cardId, { amount: '1.00', merchant: DETAILS }, code, status);
  });

  it('refuses another user\'s card with NOT_FOUND and leaves the ledger untouched', async () => {
    const cardId = await seedForeignCard();
    await expectRefused(cardId, { amount: '1.00', merchant: DETAILS }, 'NOT_FOUND', 404);
  });

  it('refuses an inactive (frozen) card with CONFLICT', async () => {
    const card = await issueVirtual('5000.00');
    await db().card.update({ where: { id: card.id }, data: { status: 'FROZEN' } });
    await expectRefused(card.id, { amount: '10.00', merchant: DETAILS }, 'CONFLICT', 409);
  });

  it('refuses a card bound to a non-CHECKING account with CONFLICT', async () => {
    const card = await issueVirtual('5000.00');
    await db().card.update({ where: { id: card.id }, data: { linkedAccountId: SAVINGS } });
    await expectRefused(card.id, { amount: '10.00', merchant: DETAILS }, 'CONFLICT', 409);
  });

  it('refuses a spend above the card monthly limit with LIMIT_EXCEEDED', async () => {
    const card = await issueVirtual('100.00');
    await expectRefused(card.id, { amount: '100.01', merchant: DETAILS }, 'LIMIT_EXCEEDED', 422);
  });

  it('refuses a spend above the bound account balance with INSUFFICIENT_FUNDS', async () => {
    const card = await issueVirtual(); // no monthly limit ⇒ governed by the account balance
    await expectRefused(card.id, { amount: '999999.00', merchant: DETAILS }, 'INSUFFICIENT_FUNDS', 422);
  });

  it.each([
    ['a missing amount', {}],
    ['a zero amount', { amount: '0.00' }],
    ['a negative amount', { amount: '-5.00' }],
    ['an over-precision amount', { amount: '1.234' }],
    ['a non-decimal amount', { amount: 'abc' }],
    ['an unsupported category', { amount: '1.00', category: '不存在类别' }],
  ] as const)('rejects %s as VALIDATION without a persisted spend', async (_label, body) => {
    const card = await issueVirtual('5000.00');
    await expectRefused(card.id, body, 'VALIDATION', 400);
  });
});

describe('GET /api/cards/[id]/consumptions', () => {
  it('lists the card\'s consumptions newest-first, scoped to the server-resolved user', async () => {
    const card = await issueVirtual('5000.00');
    const at = demoNow();

    // Real consume → list integration: a route-created row books at the SERVER instant and must
    // surface in the ledger read.
    const posted = await consume(card.id, { amount: '0.50', merchant: DETAILS });
    expect(posted.status).toBe(200);

    // The remaining rows are seeded DIRECTLY with distinct instants: every route-created row shares
    // the one server booking instant and a second-precision `createdAt`, so the route cannot
    // establish an order (see `seedConsumption`).
    await seedConsumption(card.id, { amountMinor: 200n, occurredAt: at - 1000 });
    await seedConsumption(card.id, { amountMinor: 100n, occurredAt: at - 2000 });
    // A FOREIGN owner's row for the SAME card id must never surface (ownership is server-resolved).
    await seedConsumption(card.id, { amountMinor: 999n, occurredAt: at - 500, merchant: '外部商户', userId: FOREIGN_USER });

    const res = await consumeList(card.id, '', { sessionId: 'foreign-workspace' });

    expect(res.status).toBe(200);
    expect(res.data?.ok).toBe(true);
    const rows = res.data!.data!.consumptions;
    // Newest-first by `occurredAt`: the real POST (server instant) first, then the seeded instants;
    // the foreign row sits between them in time and is filtered out by the server-resolved owner.
    expect(rows.map((row) => row.amount)).toEqual(['0.50', '2.00', '1.00']);
    expect(rows.every((row) => row.cardId === card.id && row.accountId === CHECKING)).toBe(true);
    expect(rows.map((row) => row.occurredAt)).toEqual([at, at - 1000, at - 2000]);
  });

  it('honours ?limit= and rejects an out-of-range limit as VALIDATION', async () => {
    const card = await issueVirtual('5000.00');
    const at = demoNow();
    // Seeded directly for the same reason as above: route-created rows share one booking instant.
    await seedConsumption(card.id, { amountMinor: 100n, occurredAt: at - 3000 });
    await seedConsumption(card.id, { amountMinor: 200n, occurredAt: at - 2000 });
    await seedConsumption(card.id, { amountMinor: 300n, occurredAt: at - 1000 });

    const unlimited = await consumeList(card.id);
    expect(unlimited.status).toBe(200);
    expect(unlimited.data!.data!.consumptions.map((row) => row.amount)).toEqual(['3.00', '2.00', '1.00']);

    const limited = await consumeList(card.id, '?limit=2');
    expect(limited.status).toBe(200);
    expect(limited.data!.data!.consumptions.map((row) => row.amount)).toEqual(['3.00', '2.00']);

    const single = await consumeList(card.id, '?limit=1');
    expect(single.data!.data!.consumptions.map((row) => row.amount)).toEqual(['3.00']);

    for (const bad of ['0', '501', 'abc', '1.5']) {
      const res = await consumeList(card.id, `?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(res.data).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
  });

  it('returns an empty list for a card the user does not own', async () => {
    const cardId = await seedForeignCard();

    const res = await consumeList(cardId);

    expect(res.status).toBe(200);
    expect(res.data?.ok).toBe(true);
    expect(res.data?.data?.consumptions).toEqual([]);
  });
});

/**
 * SERVER-OWNED BOOKING TIME — the security property of this surface.
 *
 * The SDK books every accepted spend at `demoNow()` and derives the monthly-limit window from that
 * SAME instant, so a client cannot back-date a spend out of the current billing month (which would
 * silently buy back monthly allowance). The route therefore REFUSES any body that merely CONTAINS
 * `occurredAt` — past, future, `0`, `-1`, fractional, string or `null` — before any delegation, with
 * `400 VALIDATION` and no state change. These specs prove the refusal is a real boundary (no money
 * moved, no row written, no `executionKey` burned) rather than a best-effort strip.
 */
describe('POST /api/cards/[id]/consume — server-owned booking time (date tampering)', () => {
  it.each([
    ['the previous demo month', demoPreviousMonthRange().start.getTime() + 60_000],
    ['the future', demoNow() + 30 * 86_400_000],
    ['the epoch', 0],
    ['a negative instant', -1],
    ['a fractional instant', 1.5],
    ['an ISO date string', '2026-08-15'],
    ['null', null],
  ] as const)('refuses a forged occurredAt value: %s', async (_label, forged) => {
    const card = await issueVirtual('100.00');

    await expectTimeRefused(card.id, { amount: '1.00', merchant: DETAILS, occurredAt: forged });

    // TOTAL refusal: not a single consumption row exists for the card, whatever the forged value.
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(0);
    expect(await db().transaction.count({ where: { merchant: DETAILS } })).toBe(0);
  });

  it('does not let a back-dated attempt escape the monthly limit (repro closed end to end)', async () => {
    const card = await issueVirtual('100.00');
    const before = await ledgerState();

    // 10.00 spends normally in the CURRENT demo month.
    expect((await consume(card.id, { amount: '10.00', merchant: DETAILS })).status).toBe(200);
    const settled = await ledgerState();

    // The 90.00 claimed as LAST month is refused outright, so it can never be booked into — or
    // excluded from — the current billing month.
    await expectTimeRefused(card.id, {
      amount: '90.00',
      merchant: DETAILS,
      occurredAt: demoPreviousMonthRange().start.getTime() + 60_000,
    });

    // Still 90.00 of allowance left ⇒ the forged request consumed nothing.
    expect((await consume(card.id, { amount: '1.00', merchant: DETAILS })).status).toBe(200);

    const after = await ledgerState();
    // Exactly 11.00 CNY is booked into the CURRENT demo month (never split across two months).
    expect(await currentMonthSpendMinor(card.id)).toBe(1100n);
    // Deltas only: the seed already carries CARD-channel history on `acct_checking`.
    expect(before.checkingBalanceMinor - after.checkingBalanceMinor).toBe(1100n);
    expect(after.transactionCount - settled.transactionCount).toBe(1);
    expect(after.consumptionCount - before.consumptionCount).toBe(2);

    const ledger = await db().transaction.findMany({ where: { merchant: DETAILS } });
    expect(ledger).toHaveLength(2);
    expect(ledger.reduce((sum, row) => sum + row.amountMinor, 0n)).toBe(-1100n);
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(2);
  });

  it('accepts spends up to the monthly limit and refuses the next 0.01 without a side effect', async () => {
    const card = await issueVirtual('100.00');

    for (const amount of ['40.00', '60.00']) {
      const res = await consume(card.id, { amount, merchant: DETAILS });
      expect(res.status).toBe(200);
      expect(res.data?.data?.consumption.amount).toBe(amount);
    }
    // Exactly at the limit: the whole 100.00 is booked into the current month.
    expect(await currentMonthSpendMinor(card.id)).toBe(10000n);

    // One cent more is a domain refusal (422) that changes nothing (asserted by `expectRefused`).
    await expectRefused(card.id, { amount: '0.01', merchant: DETAILS }, 'LIMIT_EXCEEDED', 422);

    expect(await currentMonthSpendMinor(card.id)).toBe(10000n);
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(2);
    expect(await db().transaction.count({ where: { merchant: DETAILS } })).toBe(2);
  });

  it('does not let a forged-date request consume the executionKey identity', async () => {
    const card = await issueVirtual('5000.00');
    const key = 'http-consume-forged-date-key';

    // A rejected write must claim NOTHING: otherwise a replayable row would poison the identity.
    await expectTimeRefused(card.id, {
      amount: '5.00',
      merchant: DETAILS,
      occurredAt: demoNow() - 86_400_000,
      executionKey: key,
    });
    expect(await db().cardConsumption.count({ where: { executionKey: key } })).toBe(0);

    // The SAME identity is still free for a legitimate, server-booked consume.
    const legit = await consume(card.id, { amount: '5.00', merchant: DETAILS, executionKey: key });
    expect(legit.status).toBe(200);
    expect(legit.data?.data?.consumption.executionKey).toBe(key);

    const rows = await db().cardConsumption.findMany({ where: { executionKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cardId: card.id, userId: DEMO_USER_ID, accountId: CHECKING, amountMinor: 500n, executionKey: key,
      occurredAt: new Date(demoNow()),
    });
    // Exactly ONE charge: the refused request left no ledger row behind.
    expect(await db().transaction.count({ where: { merchant: DETAILS } })).toBe(1);
    expect((await db().account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor).toBe(CHECKING_MINOR - 500n);
  });
});
