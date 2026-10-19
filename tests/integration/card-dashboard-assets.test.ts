/**
 * tests/integration/card-dashboard-assets.test.ts — SQLITE-BACKED regression for the CARD half of the
 * dashboard / asset summary (`banking-sdk/dashboard.ts#getDashboardSummary`).
 *
 * INVARIANT UNDER TEST (root CONTEXT.md): a VIRTUAL card is a DEBIT instrument bound to one owned
 * CHECKING account — its spendable amount is `min(account available cash, remaining monthly limit)`,
 * its balance IS that account's cash (never credit), and multiple cards on one account share a single
 * balance that is counted ONCE in total assets. A card replaced via loss/补办 is terminal (`LOST`) and
 * must not be counted alongside its replacement: `creditAvailable` sums the `availableLimitMinor` of
 * `CREDIT` cards that are not `LOST`.
 *
 * WHY THIS IS DB-BACKED, NOT AN ARITHMETIC UNIT TEST: both bugs are STORAGE facts. `replaceCard`
 * (banking-sdk/card.ts#replaceCard) leaves the `LOST` source row in place WITH its `availableLimitMinor`
 * intact and mints an `ACTIVE` replacement that inherits the SAME number, so any aggregation that walks
 * every `CREDIT` row reports one approved limit TWICE. A VIRTUAL card likewise adds a `Card` row but no
 * `Account` row: its cash already lives on the bound account, so asset aggregation that re-adds card
 * state double counts it — or, worse, upgrades a debit instrument into credit.
 *
 * COVERED HERE (real SDK, real seeded demo database — no model, no browser, no HTTP):
 *   1. the replacement FAMILY contributes its limit exactly ONCE (`'13579.25'`, never `'27158.50'`),
 *      while an independent `ACTIVE` CREDIT card IS added and a `LOST` CREDIT card with NO replacement
 *      is excluded;
 *   2. VIRTUAL/DEBIT cash is never credit: issuing a VIRTUAL card leaves `creditAvailable` untouched,
 *      `checkingBalance` equals the raw `acct_checking` row, and ONE real ¥100.00 consumption lowers
 *      `totalAssets` by EXACTLY ¥100.00 — once, never twice;
 *   3. the fresh-seed baseline equals cash + holdings valuation recomputed through the SDK, so a
 *      regression that starts summing card rows or drops an account is caught.
 *
 * Fixtures (`tests/helpers/fixtures.ts`): demo user 李明 — CHECKING `acct_checking` ¥23,580.00,
 * SAVINGS `acct_savings` ¥50,000.00, `card_credit` (CREDIT, available ¥18,000.00, mask `****6688`),
 * `card_debit` (DEBIT, unbound), holding 稳健理财A market value ¥5,050 (cost ¥5,000). No VIRTUAL and no
 * `LOST` card is seeded. Every amount is exact CNY minor units / decimal text — never floating point.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getDemoSession } from '@/agent';
import { createToolRegistry } from '@/agent/tools';
import { banking, type CardView, type ConsumeCardResult } from '@/banking-sdk';
import { addDecimal, subtractDecimal } from '@/lib/decimal';
import { addMoney, centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

const db = () => getTestPrisma();

/** The seeded CHECKING account — the only account a VIRTUAL card may settle against. */
const CHECKING = 'acct_checking';
/** The seeded SAVINGS account — untouched by every card operation below. */
const SAVINGS = 'acct_savings';
/** The seeded CREDIT card (¥18,000 available) — the 补办 source. */
const CREDIT = 'card_credit';
/** The seeded DEBIT card (no credit, no settlement account). */
const DEBIT = 'card_debit';

/** Fresh seed: 活期 ¥23,580.00 + 储蓄 ¥50,000.00. */
const SEEDED_CASH = '73580.00';
const SEEDED_CHECKING = '23580.00';
/** The single seeded CREDIT card is ACTIVE and nothing is LOST. */
const SEEDED_CREDIT_AVAILABLE = '18000.00';
/** The single seeded holding's unrounded market value (CNY decimal text). */
const SEEDED_HOLDINGS_VALUE = '5050';
/** 5,050 (holdings) + 73,580.00 (cash), as the summary's unrounded decimal text: '78630'. */
const SEEDED_TOTAL_ASSETS = '78630';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** Cash + holdings valuation, recomputed independently of `getDashboardSummary`. */
async function assetParts(): Promise<{ cash: string; holdingsValue: string }> {
  const balance = await banking.account.getBalance(DEMO_USER_ID);
  const holdings = await banking.investment.listHoldings(DEMO_USER_ID);
  const holdingsValue = holdings.reduce(
    (total, holding) => addDecimal(total, holding.marketValue ?? holding.amount),
    '0',
  );
  return { cash: balance.totalAvailable, holdingsValue };
}

/** The CHECKING row's own balance (CNY minor units) — the raw truth behind `checkingBalance`. */
async function checkingMinor(): Promise<bigint> {
  const row = await db().account.findUniqueOrThrow({ where: { id: CHECKING } });
  return row.balanceMinor;
}

/** Seed a CREDIT card directly, with an exact available limit and an explicit status. */
async function seedCreditCard(
  id: string,
  availableLimit: string,
  status: 'ACTIVE' | 'LOST',
): Promise<void> {
  await db().card.create({ data: {
    id,
    userId: DEMO_USER_ID,
    type: 'CREDIT',
    network: 'UnionPay',
    numberMasked: `****${id.slice(-4).padStart(4, '0')}`,
    status,
    creditLimitMinor: moneyToCents(availableLimit),
    availableLimitMinor: moneyToCents(availableLimit),
    monthlyLimitMinor: moneyToCents(availableLimit),
  } });
}

describe('dashboard credit available counts a replacement FAMILY exactly once', () => {
  it('reports the LOST source + ACTIVE replacement limit once, never twice', async () => {
    /** A non-round limit so a doubled total is unmistakably different: '13579.25' × 2 = '27158.50'. */
    const FAMILY_LIMIT = '13579.25';
    const DOUBLED = '27158.50';

    // Give the seeded credit card a distinctive available limit, then run the REAL 挂失 → 补办 flow.
    await db().card.update({
      where: { id: CREDIT },
      data: { availableLimitMinor: moneyToCents(FAMILY_LIMIT) },
    });
    const source = await banking.card.reportLostCard(CREDIT, DEMO_USER_ID, { reason: '卡片遗失' });
    expect(source.status).toBe('LOST');
    expect(source.availableLimit).toBe(FAMILY_LIMIT);

    const replacement = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);
    expect(replacement.id).not.toBe(CREDIT);
    expect(replacement).toMatchObject({
      type: 'CREDIT',
      status: 'ACTIVE',
      // The replacement inherits the source's APPROVED limit unchanged …
      creditLimit: SEEDED_CREDIT_AVAILABLE,
      // … and the source's CURRENT available limit, which is the number the summary aggregates.
      availableLimit: FAMILY_LIMIT,
    });

    // STORAGE TRUTH: the source stays terminal and KEEPS its own limit, so two rows now carry it.
    const sourceRow = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(sourceRow.status).toBe('LOST');
    expect(sourceRow.replacedByCardId).toBe(replacement.id);
    expect(sourceRow.availableLimitMinor).toBe(moneyToCents(FAMILY_LIMIT));
    const replacementRow = await db().card.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(replacementRow.status).toBe('ACTIVE');
    expect(replacementRow.availableLimitMinor).toBe(moneyToCents(FAMILY_LIMIT));

    // THE PROJECTION THE DASHBOARD AGGREGATES: both family rows are listed with the same limit …
    const creditViews = (await banking.card.getCards(DEMO_USER_ID))
      .filter((card) => card.type === 'CREDIT');
    expect(creditViews.map((card) => card.availableLimit).sort())
      .toEqual([FAMILY_LIMIT, FAMILY_LIMIT]);
    expect(creditViews.map((card) => card.status).sort()).toEqual(['ACTIVE', 'LOST']);
    // … so a naive sum over it would report the one approved limit twice. The dashboard must not.
    expect(addMoney(FAMILY_LIMIT, FAMILY_LIMIT)).toBe(DOUBLED);

    const summary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(summary.creditAvailable).toBe(FAMILY_LIMIT);
    expect(summary.creditAvailable).not.toBe(DOUBLED);
    // The already-replaced family is still ONE card's limit, not zero and not two.
    expect(summary.creditAvailable).toBe(replacement.availableLimit);
  });

  it('adds an independent ACTIVE credit card but excludes a LOST card with no replacement', async () => {
    /** A second, unrelated ACTIVE CREDIT card: 18,000.00 + 2,500.00 = 20,500.00. */
    await seedCreditCard('card_credit_extra', '2500.00', 'ACTIVE');
    /** A LOST CREDIT card that was never replaced — terminal, so its 999.00 must not count. */
    await seedCreditCard('card_credit_lost', '999.00', 'LOST');

    const summary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(summary.creditAvailable).toBe('20500.00');
    // 21,499.00 would mean the unreplaced LOST card was summed in.
    expect(summary.creditAvailable).toBe(
      addMoney(SEEDED_CREDIT_AVAILABLE, '2500.00'),
    );
    expect(summary.creditAvailable).not.toBe('21499.00');

    // Only LOST is excluded: the seeded DEBIT card holds no credit limit at all.
    const debit = (await banking.card.getCards(DEMO_USER_ID)).find((card) => card.id === DEBIT);
    expect(debit?.availableLimit).toBeUndefined();
    expect(summary.creditAvailable).not.toBe(addMoney('20500.00', SEEDED_CHECKING));
  });
});

describe('virtual/debit card cash is not credit and is counted once in total assets', () => {
  it('leaves creditAvailable untouched and lowers totalAssets by exactly one consumption', async () => {
    const before = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(before.creditAvailable).toBe(SEEDED_CREDIT_AVAILABLE);
    expect(before.checkingBalance).toBe(SEEDED_CHECKING);
    expect(before.totalAssets).toBe(SEEDED_TOTAL_ASSETS);

    // (1) Issue a VIRTUAL card bound to the CHECKING account: a DEBIT instrument, no new cash.
    const virtual = await banking.card.applyVirtualCard({
      userId: DEMO_USER_ID,
      linkedAccountId: CHECKING,
      monthlyLimit: '2000.00',
    });
    expect(virtual).toMatchObject({
      type: 'VIRTUAL',
      status: 'ACTIVE',
      linkedAccountId: CHECKING,
    });
    // Its balance IS the bound account's cash; its spendable amount is min(cash, remaining limit).
    expect(virtual.accountAvailableBalance).toBe(SEEDED_CHECKING);
    expect(virtual.payableAmount).toBe('2000.00');
    // A VIRTUAL card carries no credit limit anywhere in its projection.
    expect(virtual.availableLimit).toBeUndefined();
    expect(virtual.creditLimit).toBeUndefined();

    const afterIssue = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(afterIssue.creditAvailable).toBe(before.creditAvailable);
    expect(afterIssue.totalAssets).toBe(before.totalAssets);
    expect(afterIssue.checkingBalance).toBe(before.checkingBalance);

    // (2) Spend ¥100.00 through the card: ONE account debit, ONE ledger row, ONE consumption row.
    const SPEND = '100.00';
    const consumed = await banking.card.consumeCard({
      userId: DEMO_USER_ID,
      cardId: virtual.id,
      amount: SPEND,
      category: '购物',
      merchant: '本地模拟商户',
    });
    expect(consumed.consumption).toMatchObject({
      cardId: virtual.id,
      accountId: CHECKING,
      amount: SPEND,
      currency: 'CNY',
    });
    expect(consumed.accountAvailableBalance).toBe('23480.00');
    // Cash moved by exactly one spend: the remaining monthly allowance (2,000.00 − 100.00), not credit.
    expect(consumed.card.payableAmount).toBe(subtractMoney('2000.00', SPEND));

    const ledger = await db().transaction.findFirst({
      where: { accountId: CHECKING, channel: 'CARD', amountMinor: -moneyToCents(SPEND) },
    });
    expect(ledger).not.toBeNull();
    expect(ledger?.direction).toBe('DEBIT');
    expect(await db().cardConsumption.count({ where: { userId: DEMO_USER_ID, cardId: virtual.id } })).toBe(1);

    // (3) The dashboard after the spend.
    const after = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    // Credit is COMPLETELY unaffected by a debit instrument — neither by its cash nor its limit.
    expect(after.creditAvailable).toBe(before.creditAvailable);
    expect(after.creditAvailable).toBe(SEEDED_CREDIT_AVAILABLE);
    expect(after.creditAvailable).not.toBe(addMoney(before.creditAvailable, SPEND));
    expect(after.creditAvailable).not.toBe(addMoney(before.creditAvailable, SEEDED_CHECKING));

    // checkingBalance is exactly the account row's own balance.
    const rawChecking = await checkingMinor();
    expect(rawChecking).toBe(moneyToCents('23480.00'));
    expect(after.checkingBalance).toBe(centsToMoney(rawChecking));
    expect(after.checkingBalance).toBe('23480.00');

    // totalAssets drops by EXACTLY one ¥100.00 — the virtual card's cash is the account's cash.
    expect(after.totalAssets).toBe(subtractDecimal(before.totalAssets, SPEND));
    expect(after.totalAssets).toBe('78530');
    // Never twice: 78,630 − 200.00 would mean the card spend was deducted a second time.
    expect(after.totalAssets).not.toBe(subtractDecimal(before.totalAssets, '200.00'));

    // Independent recomputation through the SDK: cash (savings untouched) + holdings valuation.
    const { cash, holdingsValue } = await assetParts();
    expect(cash).toBe('73480.00');
    expect(after.totalAssets).toBe(addDecimal(holdingsValue, cash));
    expect(after.totalAssets).toBe('78530');
    const balance = await banking.account.getBalance(DEMO_USER_ID);
    expect(balance.accounts.find((account) => account.id === SAVINGS)?.balance).toBe('50000.00');
    expect(balance.accounts.find((account) => account.id === CHECKING)?.balance).toBe(centsToMoney(rawChecking));
  });

  it('never turns a DEBIT card into credit or assets', async () => {
    const before = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);

    // An unbound DEBIT card adds a `Card` row and nothing else: no limit, no settlement balance.
    const debit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' });
    expect(debit).toMatchObject({ type: 'DEBIT', status: 'ACTIVE' });
    expect(debit.availableLimit).toBeUndefined();
    expect(debit.creditLimit).toBeUndefined();
    expect(debit.linkedAccountId).toBeUndefined();
    // No settlement account → no cash is attributed to this card anywhere in its projection.
    expect(debit.accountAvailableBalance).toBeUndefined();
    expect(debit.payableAmount).toBeUndefined();

    const after = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(after.creditAvailable).toBe(before.creditAvailable);
    expect(after.totalAssets).toBe(before.totalAssets);
    expect(after.checkingBalance).toBe(before.checkingBalance);
    expect(after.creditAvailable).toBe(SEEDED_CREDIT_AVAILABLE);
    expect(after.totalAssets).toBe(SEEDED_TOTAL_ASSETS);
  });
});


describe('a normal virtual-card issue and spend keeps working once 补办 exists', () => {
  it('issues and spends a VIRTUAL card through the agent command path after a replacement family exists', async () => {
    // A completed 挂失 → 补办 pair in the SAME workspace: the replacement family is already there, so
    // every assertion below runs in the world 补办 creates.
    const lost = await banking.card.reportLostCard(CREDIT, DEMO_USER_ID, { reason: '卡片遗失' });
    expect(lost.status).toBe('LOST');
    const replacement = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);
    expect(replacement).toMatchObject({ type: 'CREDIT', status: 'ACTIVE', availableLimit: SEEDED_CREDIT_AVAILABLE });

    const before = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(before.creditAvailable).toBe(SEEDED_CREDIT_AVAILABLE);
    expect(before.checkingBalance).toBe(SEEDED_CHECKING);
    expect(before.totalAssets).toBe(SEEDED_TOTAL_ASSETS);

    // (1) Issue a VIRTUAL card through the SAME command path the runtime uses — issuing a VIRTUAL card
    // stays possible while creating/deleting card RECORDS stays manual-only.
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const registry = createToolRegistry(DEMO_USER_ID);
    const applied = await registry.executeDirect('apply_virtual_card', { monthlyLimit: '2000.00' }, { sessionId });
    expect(applied.ok).toBe(true);
    expect(applied.error).toBeUndefined();
    const virtual = applied.data as CardView;
    expect(virtual).toMatchObject({
      type: 'VIRTUAL',
      status: 'ACTIVE',
      // Bound to the seeded CHECKING settlement account: a DEBIT instrument, no new cash …
      linkedAccountId: CHECKING,
      monthlyLimit: '2000.00',
      accountAvailableBalance: SEEDED_CHECKING,
      // … whose spendable amount is min(account cash, remaining monthly limit).
      payableAmount: '2000.00',
    });
    expect(virtual.availableLimit).toBeUndefined();
    expect(virtual.creditLimit).toBeUndefined();
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, type: 'VIRTUAL' } })).toBe(1);

    // Issuing the card changed no money and no credit.
    const afterIssue = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(afterIssue.creditAvailable).toBe(before.creditAvailable);
    expect(afterIssue.checkingBalance).toBe(before.checkingBalance);
    expect(afterIssue.totalAssets).toBe(before.totalAssets);

    // (2) Spend ¥100.00 through that card on the same command path.
    const SPEND = '100.00';
    /** A unique merchant label, so the ledger row asserted below can only be this one spend. */
    const MERCHANT = '补办后虚拟卡回归商户';
    const consumedResult = await registry.executeDirect(
      'consume_virtual_card',
      { cardId: virtual.id, amount: SPEND, category: '购物', merchant: MERCHANT },
      { sessionId },
    );
    expect(consumedResult.ok).toBe(true);
    expect(consumedResult.error).toBeUndefined();
    const consumed = consumedResult.data as ConsumeCardResult;
    expect(consumed.consumption).toMatchObject({
      cardId: virtual.id,
      accountId: CHECKING,
      amount: SPEND,
      currency: 'CNY',
    });
    expect(consumed.accountAvailableBalance).toBe(subtractMoney(SEEDED_CHECKING, SPEND));
    expect(consumed.accountAvailableBalance).toBe('23480.00');
    expect(consumed.card.payableAmount).toBe(subtractMoney('2000.00', SPEND));

    // (3) STORAGE TRUTH: exactly ONE ledger row (negative) and ONE consumption row (positive magnitude).
    const ledgerRows = await db().transaction.findMany({
      where: { accountId: CHECKING, channel: 'CARD', merchant: MERCHANT },
    });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      userId: DEMO_USER_ID,
      direction: 'DEBIT',
      category: '购物',
      amountMinor: -moneyToCents(SPEND),
    });
    const consumptionRows = await db().cardConsumption.findMany({
      where: { userId: DEMO_USER_ID, cardId: virtual.id },
    });
    expect(consumptionRows).toHaveLength(1);
    expect(consumptionRows[0]).toMatchObject({
      accountId: CHECKING,
      category: '购物',
      merchant: MERCHANT,
      amountMinor: moneyToCents(SPEND),
    });
    const rawChecking = await checkingMinor();
    expect(rawChecking).toBe(moneyToCents('23480.00'));

    // (4) The dashboard books that ONE spend once; the debit card never becomes credit.
    const after = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(after.creditAvailable).toBe(SEEDED_CREDIT_AVAILABLE);
    expect(after.creditAvailable).toBe(before.creditAvailable);
    expect(after.creditAvailable).toBe(replacement.availableLimit);
    expect(after.checkingBalance).toBe(centsToMoney(rawChecking));
    expect(after.checkingBalance).toBe('23480.00');
    expect(after.totalAssets).toBe(subtractDecimal(before.totalAssets, SPEND));
    expect(after.totalAssets).toBe('78530');
    expect(after.totalAssets).not.toBe(subtractDecimal(before.totalAssets, '200.00'));

    // The replacement family is still exactly one ACTIVE credit card plus its LOST source.
    const creditViews = (await banking.card.getCards(DEMO_USER_ID)).filter((card) => card.type === 'CREDIT');
    expect(creditViews.map((card) => card.status).sort()).toEqual(['ACTIVE', 'LOST']);
    const { cash, holdingsValue } = await assetParts();
    expect(cash).toBe('73480.00');
    expect(after.totalAssets).toBe(addDecimal(holdingsValue, cash));
  });
});

describe('credit available is unchanged by a CREDIT 补办 and counts the replacement once', () => {
  it('keeps one approved limit across 挂失 → 补办 instead of doubling it', async () => {
    /** A non-round limit so a doubled total is unmistakable: '13579.25' × 2 = '27158.50'. */
    const FAMILY_LIMIT = '13579.25';
    await db().card.update({
      where: { id: CREDIT },
      data: { availableLimitMinor: moneyToCents(FAMILY_LIMIT) },
    });

    const before = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(before.creditAvailable).toBe(FAMILY_LIMIT);
    expect(before.totalAssets).toBe(SEEDED_TOTAL_ASSETS);

    // 挂失 alone is terminal: the source stops counting, so nothing contributes until the replacement
    // exists. Card status is not an asset, so totalAssets does not move.
    const lost = await banking.card.reportLostCard(CREDIT, DEMO_USER_ID, { reason: '卡片遗失' });
    expect(lost.status).toBe('LOST');
    expect(lost.availableLimit).toBe(FAMILY_LIMIT);
    const afterLoss = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(afterLoss.creditAvailable).toBe(centsToMoney(0n));
    expect(afterLoss.creditAvailable).toBe('0.00');
    expect(afterLoss.totalAssets).toBe(before.totalAssets);

    // 补办 inherits the SAME limit, so the total returns to that ONE approved number …
    const replacement = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);
    expect(replacement).toMatchObject({ type: 'CREDIT', status: 'ACTIVE', availableLimit: FAMILY_LIMIT });
    const after = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(after.creditAvailable).toBe(FAMILY_LIMIT);
    expect(after.creditAvailable).toBe(replacement.availableLimit);
    // … UNCHANGED by the 补办: 27,158.50 would mean the replacement family was summed twice.
    expect(after.creditAvailable).toBe(before.creditAvailable);
    expect(addMoney(FAMILY_LIMIT, FAMILY_LIMIT)).toBe('27158.50');
    expect(after.creditAvailable).not.toBe(addMoney(FAMILY_LIMIT, FAMILY_LIMIT));

    // Both family rows still CARRY the limit in storage; only the non-LOST one contributes.
    const sourceRow = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(sourceRow.status).toBe('LOST');
    expect(sourceRow.replacedByCardId).toBe(replacement.id);
    expect(sourceRow.availableLimitMinor).toBe(moneyToCents(FAMILY_LIMIT));
    const contributing = (await banking.card.getCards(DEMO_USER_ID))
      .filter((card) => card.type === 'CREDIT' && card.status !== 'LOST');
    expect(contributing.map((card) => card.id)).toEqual([replacement.id]);
    expect(
      contributing.reduce((total, card) => addMoney(total, card.availableLimit ?? '0.00'), '0.00'),
    ).toBe(after.creditAvailable);
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, type: 'CREDIT', status: { not: 'LOST' } } })).toBe(1);
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, type: 'CREDIT' } })).toBe(2);

    // A card lifecycle event never enters total assets, and it moves no cash.
    expect(after.totalAssets).toBe(before.totalAssets);
    expect(after.checkingBalance).toBe(before.checkingBalance);
  });
});
describe('seeded dashboard baseline is cash + holdings, never card rows', () => {
  it('equals the SDK-recomputed account balances plus holdings valuation', async () => {
    const summary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    const { cash, holdingsValue } = await assetParts();

    // Cash = 活期 ¥23,580.00 + 储蓄 ¥50,000.00, each counted exactly once.
    expect(cash).toBe(SEEDED_CASH);
    expect(holdingsValue).toBe(SEEDED_HOLDINGS_VALUE);
    expect(summary.checkingBalance).toBe(SEEDED_CHECKING);
    // One ACTIVE CREDIT card, nothing LOST.
    expect(summary.creditAvailable).toBe(SEEDED_CREDIT_AVAILABLE);

    // totalAssets = holdings valuation + account balances (cards are NOT accounts).
    expect(summary.totalAssets).toBe(addDecimal(holdingsValue, cash));
    expect(summary.totalAssets).toBe(SEEDED_TOTAL_ASSETS);
    // Summing card rows would inflate it; folding the credit limit in would too.
    expect(summary.totalAssets).not.toBe(addDecimal(SEEDED_TOTAL_ASSETS, summary.creditAvailable));
    expect(summary.totalAssets).not.toBe(addDecimal(addDecimal(holdingsValue, cash), SEEDED_CHECKING));

    // Canonical money text at the boundary; totalAssets is the unrounded decimal.
    expect(summary.checkingBalance).toMatch(/^-?\d+\.\d{2}$/);
    expect(summary.creditAvailable).toMatch(/^-?\d+\.\d{2}$/);
    expect(summary.totalAssets).toMatch(/^-?\d+(\.\d+)?$/);
  });
});
