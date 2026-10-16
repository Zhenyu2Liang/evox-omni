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
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { CardConsumptionView, ConsumeCardResult } from '@/banking-sdk/types';
import { POST as consumePost } from '@/app/api/cards/[id]/consume/route';
import { GET as consumptionsGet } from '@/app/api/cards/[id]/consumptions/route';
import { demoNow } from '@/lib/clock';
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
interface Envelope<T> { ok: boolean; data?: T; error?: { code: string } }
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

describe('POST /api/cards/[id]/consume', () => {
  it('debits the bound account and persists a CARD ledger row plus a CardConsumption', async () => {
    const card = await issueVirtual('5000.00');
    const before = await ledgerState();
    const at = demoNow();

    const res = await consume(card.id, { amount: '88.50', category: '餐饮', merchant: DETAILS, occurredAt: at });

    expect(res.status).toBe(200);
    expect(res.data?.ok).toBe(true);
    const result = res.data!.data!;
    expect(result.consumption).toMatchObject({
      cardId: card.id, accountId: CHECKING, amount: '88.50', currency: 'CNY',
      category: '餐饮', merchant: DETAILS, occurredAt: at,
    });
    expect(result.consumption.executionKey).toBeUndefined();
    expect(result.accountAvailableBalance).toBe('23491.50');
    expect(result.card).toMatchObject({ id: card.id, type: 'VIRTUAL', status: 'ACTIVE', accountAvailableBalance: '23491.50' });

    // The ledger row is a DEBIT on the bound account, channelled CARD, owned by the server user.
    const ledger = await db().transaction.findMany({ where: { merchant: DETAILS } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      userId: DEMO_USER_ID, accountId: CHECKING, channel: 'CARD', direction: 'DEBIT',
      category: '餐饮', merchant: DETAILS, currency: 'CNY', amountMinor: -8850n,
    });
    const consumption = await db().cardConsumption.findMany({ where: { cardId: card.id } });
    expect(consumption).toHaveLength(1);
    expect(consumption[0]).toMatchObject({
      userId: DEMO_USER_ID, accountId: CHECKING, amountMinor: 8850n, currency: 'CNY',
      category: '餐饮', merchant: DETAILS, executionKey: null,
    });

    const after = await ledgerState();
    expect(after.consumptionCount).toBe(before.consumptionCount + 1);
    expect(after.transactionCount).toBe(before.transactionCount + 1);
    expect(after.checkingBalanceMinor).toBe(CHECKING_MINOR - 8850n);
  });

  it('replays a same-executionKey consume without a second charge', async () => {
    const card = await issueVirtual('5000.00');
    const body = { amount: '12.34', category: '餐饮', merchant: DETAILS, occurredAt: demoNow(), executionKey: 'http-consume-key-1' };

    const first = await consume(card.id, body);
    const second = await consume(card.id, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.data?.data).toEqual(first.data?.data);
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
    await consume(card.id, { amount: '1.00', merchant: DETAILS, occurredAt: at - 2000 });
    await consume(card.id, { amount: '2.00', merchant: DETAILS, occurredAt: at - 1000 });
    // A FOREIGN owner's row for the SAME card id must never surface (ownership is server-resolved).
    await db().cardConsumption.create({ data: {
      cardId: card.id, accountId: CHECKING, userId: FOREIGN_USER, amountMinor: 999n, currency: 'CNY',
      category: '其他', merchant: '外部商户', occurredAt: new Date(at), executionKey: null,
    } });

    const res = await consumeList(card.id, '', { sessionId: 'foreign-workspace' });

    expect(res.status).toBe(200);
    expect(res.data?.ok).toBe(true);
    const rows = res.data!.data!.consumptions;
    expect(rows.map((row) => row.amount)).toEqual(['2.00', '1.00']);
    expect(rows.every((row) => row.cardId === card.id && row.accountId === CHECKING)).toBe(true);
  });

  it('honours ?limit= and rejects an out-of-range limit as VALIDATION', async () => {
    const card = await issueVirtual('5000.00');
    const at = demoNow();
    await consume(card.id, { amount: '1.00', merchant: DETAILS, occurredAt: at - 3000 });
    await consume(card.id, { amount: '2.00', merchant: DETAILS, occurredAt: at - 2000 });
    await consume(card.id, { amount: '3.00', merchant: DETAILS, occurredAt: at - 1000 });

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
