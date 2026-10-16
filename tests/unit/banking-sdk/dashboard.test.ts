/**
 * banking-sdk · dashboard credit aggregation regression (card-replacement double-count).
 *
 * Guards `banking-sdk/dashboard.ts#getDashboardSummary` against the credit double-count a card
 * replacement used to cause: `replaceCard` leaves the `LOST` source card in place with its
 * `availableLimitMinor` intact while minting an ACTIVE replacement that inherits the SAME limit, so
 * summing every `CREDIT` row reported the same approved credit twice (`¥36,000` for one `¥18,000`
 * card). The summary must count ONLY the un-replaced credit (a `CREDIT` row whose status is not
 * `LOST`), i.e. exactly ONE card's available limit.
 *
 * Covered here (driving the SDK, not raw SQL):
 *   - a replacement does NOT double `creditAvailable` — it stays one card's limit, and the `LOST`
 *     source stays `LOST` and is excluded even though its `availableLimitMinor` is untouched;
 *   - only ONE ACTIVE replacement exists after a replace, and a repeated `replaceCard` returns the
 *     same card without minting a second one → the total stays stable;
 *   - a FAILED replacement (real transaction, injected `card.update` failure) rolls back so no
 *     phantom ACTIVE card inflates `creditAvailable` (the summary is byte-for-byte unchanged);
 *   - a VIRTUAL/DEBIT card's linked-account balance NEVER contributes to `creditAvailable` (only true
 *     CREDIT cards count);
 *   - the money fields are exact canonical CNY strings and internally consistent with the fixtures
 *     (integer-cent math, never floating point, no balance recounted).
 *
 * Fixtures: demo user 李明 — CHECKING `acct_checking` ¥23,580 · SAVINGS `acct_savings` ¥50,000,
 * holding 稳健理财A market value ¥5,050 (cost ¥5,000), `card_credit` (CREDIT ¥18,000) and
 * `card_debit` (DEBIT). Helpers: ../../helpers/db, ../../helpers/fixtures, ../../helpers/write-failure.
 */
import { describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import { addDecimal } from '@/lib/decimal';
import { addMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { withInjectedWriteFailure } from '../../helpers/write-failure';

useFreshDatabase();

const db = () => getTestPrisma();
/** The seeded CREDIT card (¥18,000 available) — the replacement source. */
const CREDIT = 'card_credit';
/** The seeded DEBIT card (no credit, no linked account). */
const DEBIT = 'card_debit';
/** The user's default CHECKING account — the VIRTUAL-card settlement account. */
const CHECKING = 'acct_checking';

/** Await `fn`, returning whatever it rejected with; fail loudly if it unexpectedly resolves. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** The user's ACTIVE CREDIT cards (as views) — the cards whose available limit must be summed. */
async function activeCreditCards() {
  return (await banking.card.getCards(DEMO_USER_ID)).filter(
    (card) => card.type === 'CREDIT' && card.status === 'ACTIVE',
  );
}

describe('banking-sdk · dashboard credit available does not double after a replacement', () => {
  it('excludes the LOST source card so one replacement counts exactly one limit (never two)', async () => {
    const before = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(before.creditAvailable).toBe('18000.00');

    await banking.card.reportLostCard(CREDIT, DEMO_USER_ID, { reason: '遗失' });
    // The only CREDIT card is now LOST → no available credit is counted.
    expect((await banking.dashboard.getDashboardSummary(DEMO_USER_ID)).creditAvailable).toBe('0.00');

    const replacement = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);

    const after = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    // Exactly ONE card's limit — not two. Counting the LOST source again would report '36000.00'.
    expect(after.creditAvailable).toBe('18000.00');
    expect(after.creditAvailable).not.toBe('36000.00');
    // The counted limit is the ACTIVE replacement's, not a fabricated value.
    expect(after.creditAvailable).toBe(replacement.availableLimit);

    // Exactly one ACTIVE CREDIT card exists, and it is the replacement.
    const activeCredit = await activeCreditCards();
    expect(activeCredit).toHaveLength(1);
    expect(activeCredit[0].id).toBe(replacement.id);
  });

  it('keeps the replaced (old) card LOST and its untouched limit excluded', async () => {
    await banking.card.reportLostCard(CREDIT, DEMO_USER_ID);
    const replacement = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);

    // The source is terminal: still LOST, still pointing at its replacement, and still carrying the
    // inherited carriable limit in storage — which the summary must nevertheless ignore.
    const source = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(source.status).toBe('LOST');
    expect(source.replacedByCardId).toBe(replacement.id);
    expect(source.availableLimitMinor).toBe(moneyToCents('18000.00'));

    const summary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    // Only the single un-replaced credit limit is reported (NOT 18000 + 18000 = 36000).
    expect(summary.creditAvailable).toBe('18000.00');
    expect(summary.creditAvailable).toBe(addMoney('0.00', replacement.availableLimit!));
  });

  it('is stable across a repeated replaceCard: one ACTIVE card, no second mint, same total', async () => {
    await banking.card.reportLostCard(CREDIT, DEMO_USER_ID);
    const countBefore = await db().card.count({ where: { userId: DEMO_USER_ID } });

    const first = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);
    const countAfterFirst = await db().card.count({ where: { userId: DEMO_USER_ID } });
    const firstSummary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(countAfterFirst).toBe(countBefore + 1);
    expect(await activeCreditCards()).toHaveLength(1);

    const second = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);
    const secondSummary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);

    // Same replacement returned; no second card minted.
    expect(second.id).toBe(first.id);
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(countAfterFirst);
    expect(await activeCreditCards()).toHaveLength(1);

    // The aggregated total is unchanged by the replay.
    expect(secondSummary.creditAvailable).toBe(firstSummary.creditAvailable);
    expect(secondSummary.creditAvailable).toBe('18000.00');
  });
});

describe('banking-sdk · a failed replacement leaves no phantom credit', () => {
  it('rolls back the minted card (real transaction) so the summary is unchanged', async () => {
    await banking.card.reportLostCard(CREDIT, DEMO_USER_ID);

    const before = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    const countBefore = await db().card.count({ where: { userId: DEMO_USER_ID } });
    // The source is LOST, so no credit is currently counted — a leaked replacement would report 18000.
    expect(before.creditAvailable).toBe('0.00');

    // `replaceCard` mints the replacement (`card.create`) THEN links it (`card.update`) in ONE real
    // transaction; failing the second write proves the already-created row genuinely rolls back.
    const error = await capture(() =>
      withInjectedWriteFailure('card', 'update', () => banking.card.replaceCard(CREDIT, DEMO_USER_ID)),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/injected failure/);

    const after = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    // No phantom ACTIVE card inflated the total: every money field is exactly what it was.
    expect(after.creditAvailable).toBe(before.creditAvailable);
    expect(after.creditAvailable).toBe('0.00');
    expect(after.totalAssets).toBe(before.totalAssets);
    expect(after.checkingBalance).toBe(before.checkingBalance);

    // No orphan card survived, and the source is still LOST and unlinked.
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(countBefore);
    expect(await activeCreditCards()).toHaveLength(0);
    const source = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(source.status).toBe('LOST');
    expect(source.replacedByCardId).toBeNull();
  });
});

describe('banking-sdk · only true CREDIT cards contribute to available credit', () => {
  it('never counts a VIRTUAL/DEBIT card linked-account balance toward creditAvailable', async () => {
    const before = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(before.creditAvailable).toBe('18000.00');

    // A VIRTUAL card bound to the ¥23,580 CHECKING account, plus a plain DEBIT card.
    const virtual = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', monthlyLimit: '5000.00' });
    expect(virtual.linkedAccountId).toBe(CHECKING);
    expect(virtual.accountAvailableBalance).toBe('23580.00');
    await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' });

    const after = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    // The settlement card's account balance (nor its monthly limit) never leaks into credit.
    expect(after.creditAvailable).toBe(before.creditAvailable);
    expect(after.creditAvailable).toBe('18000.00');
    expect(after.creditAvailable).not.toBe(addMoney('18000.00', '23580.00')); // ≠ '41580.00'
    expect(after.creditAvailable).not.toBe(addMoney('18000.00', '5000.00')); // ≠ monthly limit
    // The linked account balance itself is unchanged by issuing the cards.
    expect(after.checkingBalance).toBe(before.checkingBalance);
  });

  it('sums every non-LOST CREDIT card in exact integer cents (FROZEN still counts)', async () => {
    const extra = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'CREDIT', creditLimit: '2500.00', monthlyLimit: '2500.00' });

    // 18000.00 + 2500.00 → exact canonical text, never a float.
    expect((await banking.dashboard.getDashboardSummary(DEMO_USER_ID)).creditAvailable).toBe('20500.00');

    // Only LOST is excluded: a temporarily FROZEN credit card keeps its available limit.
    await banking.card.freezeCard(extra.id, DEMO_USER_ID);
    expect((await banking.dashboard.getDashboardSummary(DEMO_USER_ID)).creditAvailable).toBe('20500.00');

    // Reporting the DEBIT card lost changes nothing (it holds no credit).
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID);
    expect((await banking.dashboard.getDashboardSummary(DEMO_USER_ID)).creditAvailable).toBe('20500.00');
  });
});

describe('banking-sdk · dashboard totals are internally consistent and exact', () => {
  it('composes totalAssets from cash + holdings and reports exact canonical CNY strings', async () => {
    const summary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);

    // Cash = 活期 ¥23,580 + 储蓄 ¥50,000, counted exactly once.
    const balance = await banking.account.getBalance(DEMO_USER_ID);
    expect(balance.totalAvailable).toBe('73580.00');

    // The single seeded holding's market value (¥5,050), read through the SDK.
    const holdings = await banking.investment.listHoldings(DEMO_USER_ID);
    expect(holdings.map((holding) => holding.marketValue)).toEqual(['5050']);
    const holdingsValue = holdings.reduce(
      (total, holding) => addDecimal(total, holding.marketValue ?? holding.amount),
      '0',
    );

    // totalAssets = cash + holdings, computed with exact decimal arithmetic (no float, no recount).
    expect(summary.totalAssets).toBe(addDecimal(balance.totalAvailable, holdingsValue));
    expect(summary.totalAssets).toBe('78630');

    // Money fields are canonical two-decimal CNY text.
    expect(summary.checkingBalance).toBe('23580.00');
    expect(summary.creditAvailable).toBe('18000.00');
    expect(summary.checkingBalance).toMatch(/^-?\d+\.\d{2}$/);
    expect(summary.creditAvailable).toMatch(/^-?\d+\.\d{2}$/);

    // The credit limit is credit, not cash: it is NOT folded into totalAssets.
    expect(summary.totalAssets).not.toBe(addDecimal(summary.checkingBalance, summary.creditAvailable));
  });
});
