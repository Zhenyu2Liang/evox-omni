/**
 * tests/app/card-links-http.test.ts — HTTP acceptance for the card ↔ settlement-account PROJECTION.
 *
 * These specs drive the REAL Next.js route handler in-process (no browser, no mock pipeline):
 *   - `GET /api/cards` → `GET` from `app/api/cards/route.ts` (the ONLY public card read model)
 *
 * WHY this file exists: a card no longer shows a balance of its own — a DEBIT/VIRTUAL card shows the
 * cash of the ONE owned CHECKING account it settles on (`CardView.accountAvailableBalance`) and what
 * is currently payable from it (`CardView.payableAmount`, capped by the card FAMILY's remaining
 * monthly limit). The PUBLIC JSON boundary must therefore be BOTH leak-free and honest:
 *
 *   1. `LINKED`          → masked account identity + the ACCOUNT's balance + `min(balance, remaining limit)`;
 *   2. a foreign owner's account → `UNTRUSTED`, NO balance field, and no trace of that owner's cash;
 *   3. `FROZEN`/`LOST`   → balances STILL serialized (`usable: false` is not "empty"); never `0.00`;
 *   4. no binding        → `MISSING`, NO balance field at all (never a fabricated `0.00`);
 *   5. `CREDIT`          → `NOT_APPLICABLE`, no settlement account field, credit line untouched.
 *
 * The assertions are made on the SERIALIZED envelope (`JSON.stringify(res.data)`) as well as on the
 * parsed rows, because a leak or a fabricated zero is a property of the WIRE format, not of the
 * TypeScript type: `JSON.stringify` DROPS `undefined` keys, so an absent key is the only honest
 * encoding of "this card has no balance to report". `null` or `"0.00"` would both be lies.
 *
 * Identity is resolved SERVER-SIDE from runtime config (`_lib/session#resolveUserId`), so the route
 * always reads the single demo workspace; the foreign-owner direction is therefore additionally
 * asserted through the SAME projection the route calls (`banking.card.getCards`), which is the only
 * way to read a foreign owner's list in this single-tenant simulator.
 *
 * Money is asserted as exact canonical CNY decimal strings — never floats.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { CardView } from '@/banking-sdk/types';
import { GET as cardsGet, type CardsData } from '@/app/api/cards/route';
import type { ApiSuccess } from '@/app/api/_lib/types';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { getJson } from './harness';

/** The demo owner's only CHECKING account — the settlement account the seeded DEBIT card binds. */
const CHECKING = 'acct_checking';
/** Its seeded balance, ¥23,580.00 (exact minor units 2_358_000). */
const CHECKING_BALANCE = '23580.00';
/** Its ALREADY-MASKED number as stored on `Account.number` — the only form that may be exposed. */
const CHECKING_MASK = '****8821';
/** Its display name. */
const CHECKING_NAME = '活期账户';
/** Seeded ACTIVE DEBIT card, bound to `acct_checking` by the fixtures. */
const DEBIT = 'card_debit';
/** Seeded ACTIVE CREDIT card — bound to its credit line, never to a settlement account. */
const CREDIT = 'card_credit';
/** A second owner plus its account/card: none of its cash may reach the demo owner's JSON. */
const FOREIGN_USER = 'user_other';
const FOREIGN_ACCOUNT = 'acct_other_checking';
const FOREIGN_CARD = 'card_other_debit';
const FOREIGN_NAME = '他人活期账户';
const FOREIGN_MASK = '****9999';
const FOREIGN_BALANCE_MINOR = 77_777_700n;
const FOREIGN_BALANCE = '777777.00';

const db = () => getTestPrisma();
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** Read the PUBLIC card list, returning the parsed rows AND the raw wire text of the same envelope. */
async function readCards(): Promise<{ cards: CardView[]; json: string }> {
  const res = await getJson<ApiSuccess<CardsData>>(cardsGet, '/api/cards');
  expect(res.status).toBe(200);
  expect(res.data?.ok).toBe(true);
  const cards = res.data!.data.cards;
  // The wire text of exactly what a browser would receive (undefined keys are already dropped).
  return { cards, json: JSON.stringify(res.data) };
}

/** The one card row with `id` from a card list (an explicit throw keeps the failure diagnosable). */
function cardOf(cards: CardView[], id: string): CardView {
  const card = cards.find((candidate) => candidate.id === id);
  if (card === undefined) throw new Error(`卡片列表中缺少 ${id}（实际：${cards.map((row) => row.id).join(', ')}）`);
  return card;
}

/**
 * A card with NO resolved settlement account must carry NO account data at all: not the number, not
 * the name, not a zero balance. Only `linkedAccountId` (the raw stored reference) may be present —
 * it is checked by each caller that cares, because it says nothing about resolvability.
 */
function expectNoAccountData(card: CardView): void {
  for (const key of ['linkedAccountNumber', 'linkedAccountName', 'accountAvailableBalance', 'payableAmount'] as const) {
    expect(key in card, `${card.id} 不得在响应中序列化 ${key}`).toBe(false);
    expect(card[key]).toBeUndefined();
  }
}

describe('GET /api/cards — settlement account projection', () => {
  it('shows the bound CHECKING account of a DEBIT card as masked identity plus that ACCOUNT balance', async () => {
    const account = await db().account.findUniqueOrThrow({ where: { id: CHECKING } });

    const { cards, json } = await readCards();
    const debit = cardOf(cards, DEBIT);

    expect(debit).toMatchObject({
      type: 'DEBIT',
      status: 'ACTIVE',
      usable: true,
      linkedAccountStatus: 'LINKED',
      linkedAccountId: CHECKING,
      linkedAccountName: CHECKING_NAME,
      linkedAccountNumber: CHECKING_MASK,
      // ¥23,580.00 is the ACCOUNT's cash; the card owns no second balance of its own.
      accountAvailableBalance: CHECKING_BALANCE,
      // `card_debit.monthlyLimit === null` ⇒ unlimited ⇒ payable is the account balance alone.
      payableAmount: CHECKING_BALANCE,
    });
    expect(debit.monthlyLimit).toBeUndefined();
    expect(account.balanceMinor).toBe(2_358_000n);

    // Echoed EXACTLY as stored, and the stored form is masked — a full account number is never
    // reconstructed, appended to or exposed in any other field.
    expect(debit.linkedAccountNumber).toBe(account.number);
    expect(debit.linkedAccountNumber).toMatch(/^\*{4}\d{4}$/);
    // No 12+ digit run anywhere in the envelope: a full (16-digit) account number would show up here.
    expect(json).not.toMatch(/\d{12,}/);
    // And no raw account row leaks in (the response carries the view, not the persistence model).
    expect(json).not.toContain('balanceMinor');
    expect(json).not.toContain('2358000');
  });

  it('caps payableAmount at the remaining monthly limit and keeps reporting the ACCOUNT balance raw', async () => {
    // Two virtual cards on the SAME account: a tight limit (min applies) and a limit above the cash.
    const tight = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit: '100.00', linkedAccountId: CHECKING });
    const loose = await banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit: '99999.00', linkedAccountId: CHECKING });

    const before = await readCards();
    expect(cardOf(before.cards, tight.id)).toMatchObject({
      linkedAccountStatus: 'LINKED',
      linkedAccountName: CHECKING_NAME,
      linkedAccountNumber: CHECKING_MASK,
      accountAvailableBalance: CHECKING_BALANCE,
      payableAmount: '100.00', // min(23580.00, 100.00 - 0.00 spent) = 100.00
    });
    expect(cardOf(before.cards, loose.id)).toMatchObject({
      accountAvailableBalance: CHECKING_BALANCE,
      payableAmount: CHECKING_BALANCE, // min(23580.00, 99999.00 - 0.00 spent) = 23580.00
    });

    // A spend moves BOTH numbers on the next read: the account cash drops and the remaining monthly
    // allowance drops — `payableAmount` is derived, never a stored duplicate of either one.
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: tight.id, amount: '30.00', merchant: 'HTTP绑定回归' });
    const after = await readCards();
    expect(cardOf(after.cards, tight.id)).toMatchObject({
      accountAvailableBalance: '23550.00',
      payableAmount: '70.00',
    });
    // The other card on the same account shares the account cash, but not the limit.
    expect(cardOf(after.cards, loose.id)).toMatchObject({
      accountAvailableBalance: '23550.00',
      payableAmount: '23550.00',
    });
  });

  it("never exposes another owner's account (or its cash) when a card points at it", async () => {
    // Owner B, with a distinctive CHECKING account whose every attribute is unmistakable in a leak.
    await db().user.create({ data: { id: FOREIGN_USER, name: '他人', phone: '13900003344' } });
    await db().account.create({ data: {
      id: FOREIGN_ACCOUNT, userId: FOREIGN_USER, type: 'CHECKING',
      name: FOREIGN_NAME, number: FOREIGN_MASK, balanceMinor: FOREIGN_BALANCE_MINOR, currency: 'CNY',
    } });
    // A's DEBIT card rebound (direct row write, the FK is satisfied — the account exists) to B's
    // account. OWNERSHIP, not existence, is what must decide: this is `UNTRUSTED`, not `LINKED`.
    await db().card.update({ where: { id: DEBIT }, data: { linkedAccountId: FOREIGN_ACCOUNT } });
    // …and B's own card pointing at A's account, for the inverse direction below.
    await db().card.create({ data: {
      id: FOREIGN_CARD, userId: FOREIGN_USER, type: 'DEBIT', network: 'UnionPay',
      numberMasked: '****0002', status: 'ACTIVE', linkedAccountId: CHECKING,
    } });

    const { cards, json } = await readCards();
    const debit = cardOf(cards, DEBIT);
    expect(debit).toMatchObject({ status: 'ACTIVE', usable: true, linkedAccountStatus: 'UNTRUSTED', linkedAccountId: FOREIGN_ACCOUNT });
    expectNoAccountData(debit);
    // Nothing about B's money or B's card reached the demo owner's public list.
    expect(cards.map((card) => card.id)).not.toContain(FOREIGN_CARD);
    expect(json).not.toContain(FOREIGN_BALANCE);
    expect(json).not.toContain(FOREIGN_NAME);
    expect(json).not.toContain(FOREIGN_MASK);
    // …nor about the demo owner's own account, which no card links anymore.
    expect(json).not.toContain(CHECKING_NAME);
    // A `"0.00"` here would be a fabricated balance: the field is absent entirely.
    expect(json).not.toContain('"accountAvailableBalance":"0.00"');
    expect(json).not.toContain('"accountAvailableBalance":null');

    // Inverse direction: B reading the SAME projection must not see A's account either. `GET /api/cards`
    // is bound to the single demo identity, so a foreign owner's list is read through the very
    // projection function the route calls.
    const foreignCards = await banking.card.getCards(FOREIGN_USER);
    const foreignCard = cardOf(foreignCards, FOREIGN_CARD);
    expect(foreignCard).toMatchObject({ linkedAccountStatus: 'UNTRUSTED', linkedAccountId: CHECKING });
    expectNoAccountData(foreignCard);
    const foreignJson = JSON.stringify(foreignCards);
    expect(foreignJson).not.toContain(CHECKING_BALANCE);
    expect(foreignJson).not.toContain(CHECKING_MASK);
    expect(foreignJson).not.toContain(CHECKING_NAME);
  });

  it('keeps the REAL balance of a FROZEN card and only reports it as unusable', async () => {
    await banking.card.freezeCard(DEBIT, DEMO_USER_ID);

    const { cards, json } = await readCards();
    const debit = cardOf(cards, DEBIT);
    expect(debit).toMatchObject({
      status: 'FROZEN',
      usable: false,
      linkedAccountStatus: 'LINKED',
      linkedAccountNumber: CHECKING_MASK,
      linkedAccountName: CHECKING_NAME,
      accountAvailableBalance: CHECKING_BALANCE,
      payableAmount: CHECKING_BALANCE,
    });
    // Unusable is NOT empty: a frozen card must never be serialized as a drained account.
    expect(debit.accountAvailableBalance).not.toBe('0.00');
    expect(debit.payableAmount).not.toBe('0.00');
    expect(json).not.toContain('"accountAvailableBalance":"0.00"');
  });

  it('keeps the REAL balance of a LOST card and only reports it as unusable', async () => {
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID, { reason: '卡片丢失' });

    const { cards, json } = await readCards();
    const debit = cardOf(cards, DEBIT);
    expect(debit).toMatchObject({
      status: 'LOST',
      usable: false,
      linkedAccountStatus: 'LINKED',
      linkedAccountNumber: CHECKING_MASK,
      linkedAccountName: CHECKING_NAME,
      accountAvailableBalance: CHECKING_BALANCE,
      payableAmount: CHECKING_BALANCE,
    });
    expect(debit.accountAvailableBalance).not.toBe('0.00');
    expect(debit.payableAmount).not.toBe('0.00');
    expect(json).not.toContain('"accountAvailableBalance":"0.00"');
    // Reporting the loss moved no money: the projection still reflects the untouched account.
    expect((await db().account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor).toBe(2_358_000n);
  });

  it('reports MISSING — with NO balance field at all — for a card without a settlement account', async () => {
    await db().card.update({ where: { id: DEBIT }, data: { linkedAccountId: null } });

    const { cards, json } = await readCards();
    const debit = cardOf(cards, DEBIT);
    // Still an ACTIVE, usable card — it simply has no account to report a balance for.
    expect(debit).toMatchObject({ status: 'ACTIVE', usable: true, linkedAccountStatus: 'MISSING' });
    // The raw reference is absent too (it is `null` in storage, never a dangling id).
    expect('linkedAccountId' in debit).toBe(false);
    expect(debit.linkedAccountId).toBeUndefined();
    expectNoAccountData(debit);
    // A MISSING binding must not be encoded as a zero balance, a null or an empty string.
    expect(json).not.toContain('"accountAvailableBalance"');
    expect(json).not.toContain('"payableAmount"');
    expect(json).not.toContain('"accountAvailableBalance":"0.00"');
  });

  it('never gives a CREDIT card a settlement account — even if one is recorded on the row', async () => {
    const seeded = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(seeded.linkedAccountId).toBeNull();

    const { cards } = await readCards();
    const credit = cardOf(cards, CREDIT);
    expect(credit).toMatchObject({
      type: 'CREDIT',
      status: 'ACTIVE',
      usable: true,
      linkedAccountStatus: 'NOT_APPLICABLE',
      // The credit line is untouched and stays visible — a credit card draws on it, not on cash.
      creditLimit: '18000.00',
      availableLimit: '18000.00',
    });
    expect('linkedAccountId' in credit).toBe(false);
    expectNoAccountData(credit);
    // Its OWN wire row carries no balance key (the envelope legitimately carries the linked DEBIT
    // card's balance, so the assertion is scoped to this card's serialization).
    expect(JSON.stringify(credit)).not.toContain('"accountAvailableBalance"');
    expect(JSON.stringify(credit)).not.toContain('"payableAmount"');
    expect(JSON.stringify(credit)).not.toContain('"linkedAccountNumber"');

    // A corrupted/legacy pointer must not turn a credit line into somebody's cash: the status stays
    // `NOT_APPLICABLE`, so no account is looked up and no balance field is emitted.
    await db().card.update({ where: { id: CREDIT }, data: { linkedAccountId: CHECKING } });
    const poisoned = cardOf((await readCards()).cards, CREDIT);
    expect(poisoned).toMatchObject({ linkedAccountStatus: 'NOT_APPLICABLE', creditLimit: '18000.00', availableLimit: '18000.00' });
    expect(poisoned.linkedAccountId).toBe(CHECKING);
    expectNoAccountData(poisoned);
    expect(JSON.stringify(poisoned)).not.toContain('"accountAvailableBalance"');
    expect(JSON.stringify(poisoned)).not.toContain('"payableAmount"');
  });
});
