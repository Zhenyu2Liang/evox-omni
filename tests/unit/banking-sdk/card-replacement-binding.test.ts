/**
 * banking-sdk · VIRTUAL-card replacement: settlement binding + monthly-limit continuity.
 *
 * Pure SDK-level acceptance for the 补办 contract that lives in `banking-sdk/card.ts`:
 *   - `replaceCard` on a `LOST` VIRTUAL card MINTS a new `ACTIVE` row that INHERITS the source's
 *     `linkedAccountId`, re-validated in the same transaction (row exists, owned by the user,
 *     `CHECKING`). A source with a broken binding (foreign / `SAVINGS` / `null`) is a
 *     `CONFLICT` and mints NOTHING — a dead card is never issued. The validation runs BEFORE the
 *     idempotent return, so a broken source can never replay into a dead card either. A recorded
 *     binding that names a NONEXISTENT account cannot be constructed at all: `linkedAccountId` is a
 *     real FK, so the row is refused by SQLite before the SDK ever sees it;
 *   - the replacement can spend IMMEDIATELY: `consumeCard` debits the bound account exactly once
 *     (one `channel='CARD'` ledger row + one `CardConsumption` row, both in the same transaction);
 *   - the monthly limit travels WITH the plastic: the enforced limit AND the projected
 *     `payableAmount` both read the replacement FAMILY's current-month spend
 *     (`banking-sdk/card-family.ts`, walking `replacedByCardId` in both directions), so the already
 *     booked `CardConsumption` rows stay attributed to the card that incurred them and are NEVER
 *     rewritten;
 *   - replacement is IDEMPOTENT (a replay returns the same card, mints no second row) and works
 *     across generations (A → B → C keeps ONE continuous monthly allowance);
 *   - a replacement minted BEFORE bindings were inherited (`linkedAccountId === null`) is repaired
 *     from its EXPLICIT predecessor link — on the `replaceCard` replay path and on `consumeCard` —
 *     and persisted; with NO explicit predecessor it is refused (`CONFLICT`), never guessed from a
 *     default account;
 *   - CREDIT replacement is unchanged: the same approved credit limit + available limit travel over
 *     (no re-approval) and the dashboard counts that credit ONCE (the `LOST` source is excluded).
 *
 * All money is asserted as exact canonical CNY decimal strings / integer minor units — never floats.
 *
 * Fixtures: demo user 李明, `acct_checking` (CHECKING ¥23,580, mask `****8821`) and `acct_savings`
 * (SAVINGS ¥50,000 — never a valid settlement account); the seed ships no VIRTUAL card, so these
 * specs issue them through the SDK (`applyVirtualCard`) exactly like the production path.
 *
 * NOTE: `useFreshDatabase()` resets through the shared `truncateAll()`, which clears EVERY model of
 * the schema — including the relation-free `CardConsumption` ledger — so every spec starts from
 * a genuinely empty spend history without an extra hook.
 */
import { describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { ApplyVirtualCardInput, CardView } from '@/banking-sdk/types';
import { demoMonthRange, demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const db = () => getTestPrisma();

/** The user's default CHECKING account (¥23,580) — the only valid settlement account in the seed. */
const CHECKING = 'acct_checking';
/** A SAVINGS account — never a valid settlement account for a card. */
const SAVINGS = 'acct_savings';
/** `card_credit`: CREDIT with an approved ¥18,000 credit limit + ¥18,000 monthly limit. */
const CREDIT = 'card_credit';
/** A user that owns none of the demo data — proves the ownership fence on a recorded binding. */
const FOREIGN_USER = 'user_intruder';
/** The foreign user's CHECKING account — exists, is CHECKING, but is not owned by 李明. */
const FOREIGN_CHECKING = 'acct_foreign';

/** Await `fn`, returning whatever it rejected with; fail loudly if it unexpectedly resolves. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** Assert the rejection is an `AppError` carrying the expected domain code. */
function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

/** Issue a VIRTUAL card for the demo user (optionally overriding the binding / monthly limit). */
function issueVirtual(input: Omit<Partial<ApplyVirtualCardInput>, 'userId'> = {}): Promise<CardView> {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, ...input });
}

/** The exact balance of an account as canonical CNY text. */
async function balanceOf(accountId = CHECKING): Promise<string> {
  const row = await db().account.findUniqueOrThrow({ where: { id: accountId } });
  return centsToMoney(row.balanceMinor);
}

/** The enriched `CardView` for one of the user's cards (the exact projection `getCards` returns). */
async function viewOf(cardId: string): Promise<CardView> {
  const view = (await banking.card.getCards(DEMO_USER_ID)).find((candidate) => candidate.id === cardId);
  if (!view) throw new Error(`card ${cardId} not found`);
  return view;
}

/** Every masked card number currently stored (used to prove "no new card was minted"). */
async function maskedNumbers(): Promise<Set<string>> {
  return new Set((await db().card.findMany()).map((card) => card.numberMasked));
}

/**
 * A byte-level snapshot of the whole consumption ledger. The 补办 must never rewrite history, so a
 * spec compares this BEFORE and AFTER and requires it to be identical (same ids, same attribution).
 */
async function consumptionLedger(): Promise<Array<Record<string, unknown>>> {
  const rows = await db().cardConsumption.findMany({ orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  return rows.map((row) => ({
    id: row.id,
    cardId: row.cardId,
    accountId: row.accountId,
    userId: row.userId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    category: row.category,
    merchant: row.merchant,
    occurredAt: row.occurredAt.toISOString(),
    executionKey: row.executionKey,
    resultJson: row.resultJson,
  }));
}

/** Create a foreign user owning a CHECKING account (never a valid settlement target for 李明). */
async function addForeignUser(): Promise<void> {
  await db().user.create({ data: { id: FOREIGN_USER, name: '外部用户', phone: '137****9999' } });
  await db().account.create({ data: {
    id: FOREIGN_CHECKING,
    userId: FOREIGN_USER,
    type: 'CHECKING',
    name: '外部活期',
    number: '****0003',
    balanceMinor: moneyToCents('5000.00'),
  } });
}

/**
 * Insert a card row DIRECTLY (bypassing the SDK) so a BROKEN state — one the SDK itself can no
 * longer produce — can be reproduced: a `LOST` VIRTUAL source whose recorded binding is stale, or
 * an `ACTIVE` VIRTUAL replacement minted before bindings were inherited. `numberMasked` is a
 * distinct literal so "no new mask was minted" assertions stay meaningful.
 */
async function insertCard(data: {
  id: string;
  type: 'VIRTUAL' | 'CREDIT' | 'DEBIT';
  status: 'ACTIVE' | 'LOST';
  numberMasked: string;
  linkedAccountId: string | null;
  monthlyLimitMinor?: bigint | null;
  replacedByCardId?: string | null;
}): Promise<void> {
  await db().card.create({ data: {
    id: data.id,
    userId: DEMO_USER_ID,
    type: data.type,
    network: 'UnionPay',
    numberMasked: data.numberMasked,
    status: data.status,
    creditLimitMinor: null,
    availableLimitMinor: null,
    monthlyLimitMinor: data.monthlyLimitMinor ?? moneyToCents('100.00'),
    replacedByCardId: data.replacedByCardId ?? null,
    linkedAccountId: data.linkedAccountId,
  } });
}

describe('banking-sdk · a VIRTUAL replacement inherits the settlement binding', () => {
  it('carries linkedAccountId to the new card, persists it and keeps it across a projection refresh', async () => {
    const masksBefore = await maskedNumbers();
    const source = await issueVirtual({ monthlyLimit: '100.00' });
    expect(source.linkedAccountId).toBe(CHECKING);

    await banking.card.reportLostCard(source.id, DEMO_USER_ID, { reason: '遗失' });
    const replacement = await banking.card.replaceCard(source.id, DEMO_USER_ID);

    // Same owner/type/network, ACTIVE, fresh masked number, monthly limit carried over.
    expect(replacement.id).not.toBe(source.id);
    expect(replacement.type).toBe('VIRTUAL');
    expect(replacement.status).toBe('ACTIVE');
    expect(replacement.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(masksBefore.has(replacement.numberMasked)).toBe(false);
    expect(replacement.monthlyLimit).toBe('100.00');

    // The BINDING travelled with the plastic...
    expect(replacement.linkedAccountId).toBe(CHECKING);
    // ...and it is a PERSISTED column value, not just a projection detail.
    expect((await db().card.findUniqueOrThrow({ where: { id: replacement.id } })).linkedAccountId).toBe(CHECKING);

    // A fresh projection load (what the UI reads on refresh) still resolves the account.
    const refreshed = await viewOf(replacement.id);
    expect(refreshed.linkedAccountId).toBe(CHECKING);
    expect(refreshed.linkedAccountNumber).toBe('****8821');
    expect(refreshed.accountAvailableBalance).toBe('23580.00');
    expect(refreshed.payableAmount).toBe('100.00'); // min(¥23,580 balance, ¥100 monthly limit)

    // Re-read the ROW again AFTER the projection load: the binding is still there.
    expect((await db().card.findUniqueOrThrow({ where: { id: replacement.id } })).linkedAccountId).toBe(CHECKING);

    // The source stays terminal and points at exactly ONE replacement.
    const sourceRow = await db().card.findUniqueOrThrow({ where: { id: source.id } });
    expect(sourceRow.status).toBe('LOST');
    expect(sourceRow.replacedByCardId).toBe(replacement.id);
    expect(sourceRow.linkedAccountId).toBe(CHECKING);
  });
});

describe('banking-sdk · a VIRTUAL replacement can spend immediately', () => {
  it('debits the inherited account exactly once and books one CARD ledger row + one consumption row', async () => {
    const source = await issueVirtual({ monthlyLimit: '100.00' });
    await banking.card.reportLostCard(source.id, DEMO_USER_ID);
    const replacement = await banking.card.replaceCard(source.id, DEMO_USER_ID);

    // Snapshot the seeded ledger: the fixture already contains `channel='CARD'` spend rows, so the
    // assertions below are deltas / merchant-scoped instead of a naked table scan.
    const cardChannelBefore = await db().transaction.count({ where: { userId: DEMO_USER_ID, channel: 'CARD' } });
    const transactionsBefore = await db().transaction.count();

    const merchant = '补办后即时消费';
    const result = await banking.card.consumeCard({
      userId: DEMO_USER_ID,
      cardId: replacement.id,
      amount: '50.00',
      merchant,
      category: '购物',
    });

    // 23580.00 - 50.00, reported by the SDK and by the account row alike.
    expect(result.accountAvailableBalance).toBe('23530.00');
    expect(await balanceOf()).toBe('23530.00');
    // The remaining allowance follows the same family number.
    expect(result.card.payableAmount).toBe('50.00'); // min(¥23,530, ¥100 - ¥50)
    expect(result.card.linkedAccountId).toBe(CHECKING);

    // The booking instant is the SERVER clock, inside the current billing month.
    expect(result.consumption.occurredAt).toBe(demoNow());
    const { start, end } = demoMonthRange();
    expect(result.consumption.occurredAt).toBeGreaterThanOrEqual(start.getTime());
    expect(result.consumption.occurredAt).toBeLessThan(end.getTime());

    // Exactly ONE ledger row for this spend, signed negative and marked as a card debit.
    const ledger = await db().transaction.findMany({ where: { userId: DEMO_USER_ID, channel: 'CARD', merchant } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].accountId).toBe(CHECKING);
    expect(ledger[0].amountMinor).toBe(-5000n);
    expect(ledger[0].direction).toBe('DEBIT');
    expect(ledger[0].occurredAt.getTime()).toBe(demoNow());
    expect(await db().transaction.count()).toBe(transactionsBefore + 1);
    expect(await db().transaction.count({ where: { userId: DEMO_USER_ID, channel: 'CARD' } })).toBe(cardChannelBefore + 1);

    // Exactly ONE consumption row, attributed to the REPLACEMENT card and the inherited account.
    const consumptions = await db().cardConsumption.findMany();
    expect(consumptions).toHaveLength(1);
    expect(consumptions[0].cardId).toBe(replacement.id);
    expect(consumptions[0].accountId).toBe(CHECKING);
    expect(consumptions[0].amountMinor).toBe(5000n);
  });
});

describe('banking-sdk · the monthly limit continues across a replacement', () => {
  it('spends the SOURCE history against the replacement allowance without rewriting it', async () => {
    const source = await issueVirtual({ monthlyLimit: '100.00' });

    // ¥30 spent on the ORIGINAL card, before the loss.
    const first = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: source.id, amount: '30.00', merchant: '补办前消费' });
    expect(first.accountAvailableBalance).toBe('23550.00');
    expect(await balanceOf()).toBe('23550.00');

    // Snapshot the pre-replacement history: the 补办 must not touch it.
    const historyBefore = await consumptionLedger();
    expect(historyBefore).toHaveLength(1);
    expect(historyBefore[0].cardId).toBe(source.id);
    expect(historyBefore[0].amountMinor).toBe(3000n);

    await banking.card.reportLostCard(source.id, DEMO_USER_ID);
    const replacement = await banking.card.replaceCard(source.id, DEMO_USER_ID);

    // The replacement continues the SAME month: ¥100 - ¥30 = ¥70 remaining.
    expect(replacement.monthlyLimit).toBe('100.00');
    expect(replacement.payableAmount).toBe('70.00');
    expect(replacement.accountAvailableBalance).toBe('23550.00');

    // ¥70 succeeds and exhausts the family allowance.
    const second = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: replacement.id, amount: '70.00', merchant: '补办后消费' });
    expect(second.accountAvailableBalance).toBe('23480.00');
    expect(await balanceOf()).toBe('23480.00');
    expect(second.card.payableAmount).toBe('0.00');

    // The NEXT cent is over the limit — refused before any write.
    const balanceBeforeRefusal = await balanceOf();
    const consumptionsBeforeRefusal = await db().cardConsumption.count();
    const transactionsBeforeRefusal = await db().transaction.count();
    const cardsBeforeRefusal = await db().card.count();

    const overLimit = await capture(() =>
      banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: replacement.id, amount: '0.01', merchant: '超限消费' }),
    );
    expectCode(overLimit, 'LIMIT_EXCEEDED');

    expect(await balanceOf()).toBe(balanceBeforeRefusal);
    expect(await db().cardConsumption.count()).toBe(consumptionsBeforeRefusal);
    expect(await db().transaction.count()).toBe(transactionsBeforeRefusal);
    expect(await db().card.count()).toBe(cardsBeforeRefusal);

    // The ¥30 history was NOT rewritten: byte-identical and still attributed to the SOURCE card.
    const historyAfter = (await consumptionLedger()).filter((row) => row.cardId !== replacement.id);
    expect(historyAfter).toEqual(historyBefore);
    expect(historyAfter[0].cardId).toBe(source.id);
    expect(historyAfter[0].amountMinor).toBe(3000n);

    // ...while the replacement owns only the ¥70 it actually incurred.
    const replacementRows = (await consumptionLedger()).filter((row) => row.cardId === replacement.id);
    expect(replacementRows).toHaveLength(1);
    expect(replacementRows[0].amountMinor).toBe(7000n);
    expect(replacementRows[0].accountId).toBe(CHECKING);
  });
});

describe('banking-sdk · repeated and multi-generation replacement', () => {
  it('returns the SAME replacement on a replay and mints no second card', async () => {
    const source = await issueVirtual({ monthlyLimit: '100.00' });
    await banking.card.reportLostCard(source.id, DEMO_USER_ID);
    const first = await banking.card.replaceCard(source.id, DEMO_USER_ID);
    const countAfterFirst = await db().card.count({ where: { userId: DEMO_USER_ID } });
    const masksAfterFirst = await maskedNumbers();

    const second = await banking.card.replaceCard(source.id, DEMO_USER_ID);

    expect(second.id).toBe(first.id);
    expect(second.numberMasked).toBe(first.numberMasked);
    expect(second.linkedAccountId).toBe(CHECKING);
    // No second mint: same card count, same masked numbers, ONE replacement pointer.
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(countAfterFirst);
    expect(await maskedNumbers()).toEqual(masksAfterFirst);
    expect((await db().card.findUniqueOrThrow({ where: { id: source.id } })).replacedByCardId).toBe(first.id);
    // Only ONE row points at the replacement (the source), so a replay cannot fork the family.
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, replacedByCardId: first.id } })).toBe(1);
  });

  it('keeps ONE monthly allowance across A → B → C (spend on every generation counts once)', async () => {
    const a = await issueVirtual({ monthlyLimit: '100.00' });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: a.id, amount: '30.00', merchant: '第一代消费' });

    await banking.card.reportLostCard(a.id, DEMO_USER_ID);
    const b = await banking.card.replaceCard(a.id, DEMO_USER_ID);
    expect(b.linkedAccountId).toBe(CHECKING);
    expect(b.payableAmount).toBe('70.00'); // ¥100 - ¥30 spent on A
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: b.id, amount: '20.00', merchant: '第二代消费' });

    await banking.card.reportLostCard(b.id, DEMO_USER_ID);
    const c = await banking.card.replaceCard(b.id, DEMO_USER_ID);

    // C inherits B's binding and continues the SAME allowance: ¥100 - ¥30 - ¥20 = ¥50.
    expect(c.linkedAccountId).toBe(CHECKING);
    expect(c.monthlyLimit).toBe('100.00');
    expect(c.linkedAccountNumber).toBe('****8821');
    expect(c.payableAmount).toBe('50.00'); // min(¥23,530, ¥50 remaining)
    expect(c.accountAvailableBalance).toBe('23530.00'); // 23580 - 30 - 20
    expect((await db().card.findUniqueOrThrow({ where: { id: c.id } })).linkedAccountId).toBe(CHECKING);

    // The whole ¥50 succeeds; one more cent does not.
    const last = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: c.id, amount: '50.00', merchant: '第三代消费' });
    expect(last.accountAvailableBalance).toBe('23480.00');
    expect(last.card.payableAmount).toBe('0.00');
    expect(await balanceOf()).toBe('23480.00');

    const balanceBeforeRefusal = await balanceOf();
    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: c.id, amount: '0.01' })),
      'LIMIT_EXCEEDED',
    );
    expect(await balanceOf()).toBe(balanceBeforeRefusal);

    // Every generation keeps its OWN booked rows: 30 / 20 / 50, never merged or rewritten.
    const rows = await db().cardConsumption.findMany({ orderBy: { amountMinor: 'desc' } });
    expect(rows.map((row) => ({ cardId: row.cardId, amountMinor: row.amountMinor }))).toEqual([
      { cardId: c.id, amountMinor: 5000n },
      { cardId: a.id, amountMinor: 3000n },
      { cardId: b.id, amountMinor: 2000n },
    ]);
    expect(rows.every((row) => row.accountId === CHECKING)).toBe(true);
    // The chain A → B → C is intact.
    expect((await db().card.findUniqueOrThrow({ where: { id: a.id } })).replacedByCardId).toBe(b.id);
    expect((await db().card.findUniqueOrThrow({ where: { id: b.id } })).replacedByCardId).toBe(c.id);
  });
});

describe('banking-sdk · a broken source binding never mints a dead card', () => {
  it('rejects a foreign / SAVINGS / absent binding with CONFLICT and writes nothing', async () => {
    await addForeignUser();

    // `Card.linkedAccountId` is a REAL foreign key, so "records an account id that does not exist" is
    // UNREPRESENTABLE: the insert itself is refused. The UNTRUSTED state is therefore covered with an
    // account that EXISTS but is not the owner's CHECKING account (foreign / wrong type).
    await expect(insertCard({ id: 'card_src_ghost', type: 'VIRTUAL', status: 'LOST', numberMasked: '****0098', linkedAccountId: 'acct_missing' }))
      .rejects.toThrow(/foreign key/i);
    const brokenSources: ReadonlyArray<{ label: string; id: string; linkedAccountId: string | null }> = [
      { label: 'foreign CHECKING account', id: 'card_src_foreign', linkedAccountId: FOREIGN_CHECKING },
      { label: 'SAVINGS account', id: 'card_src_savings', linkedAccountId: SAVINGS },
      { label: 'no binding at all', id: 'card_src_unbound', linkedAccountId: null },
    ];
    // The seeded world (CREDIT + DEBIT) — the broken sources are added on top of it.
    const seededCards = await db().card.count({ where: { userId: DEMO_USER_ID } });
    for (const source of brokenSources) {
      await insertCard({ id: source.id, type: 'VIRTUAL', status: 'LOST', numberMasked: `****${source.id.slice(-4)}`, linkedAccountId: source.linkedAccountId });
    }

    for (const source of brokenSources) {
      const cardsBefore = await db().card.count({ where: { userId: DEMO_USER_ID } });
      const masksBefore = await maskedNumbers();

      const error = await capture(() => banking.card.replaceCard(source.id, DEMO_USER_ID));

      // The SDK throws CONFLICT for every one of these (never a silent mint, never a guess).
      expectCode(error, 'CONFLICT');
      expect((error as AppError).message.length).toBeGreaterThan(0);

      // No new card row and no new masked number.
      expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(cardsBefore);
      expect(await maskedNumbers()).toEqual(masksBefore);

      // The source is untouched: still LOST, still unlinked.
      const row = await db().card.findUniqueOrThrow({ where: { id: source.id } });
      expect(row.status).toBe('LOST');
      expect(row.replacedByCardId).toBeNull();
      expect(row.linkedAccountId).toBe(source.linkedAccountId);
    }

    // Nothing was minted by any of the three rejections either.
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(seededCards + brokenSources.length);
  });
});

describe('banking-sdk · a replacement minted without a binding is repaired from its explicit link', () => {
  it('repairs on the replaceCard replay path and spends from the source account afterwards', async () => {
    // `card_broken_active` was minted BEFORE bindings were inherited: ACTIVE, VIRTUAL, unbound.
    await insertCard({ id: 'card_broken_active', type: 'VIRTUAL', status: 'ACTIVE', numberMasked: '****9001', linkedAccountId: null });
    // Its EXPLICIT predecessor records the real settlement account.
    await insertCard({
      id: 'card_broken_source',
      type: 'VIRTUAL',
      status: 'LOST',
      numberMasked: '****9002',
      linkedAccountId: CHECKING,
      replacedByCardId: 'card_broken_active',
    });

    const cardsBefore = await db().card.count({ where: { userId: DEMO_USER_ID } });
    const repaired = await banking.card.replaceCard('card_broken_source', DEMO_USER_ID);

    // The idempotent replay returned the EXISTING replacement — repaired from the explicit link.
    expect(repaired.id).toBe('card_broken_active');
    expect(repaired.linkedAccountId).toBe(CHECKING);
    expect(repaired.payableAmount).toBe('100.00');
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(cardsBefore);

    // The repair is PERSISTED, not just projected.
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_broken_active' } })).linkedAccountId).toBe(CHECKING);
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_broken_source' } })).replacedByCardId).toBe('card_broken_active');

    // And the repaired card can actually spend from that account.
    const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: 'card_broken_active', amount: '10.00', merchant: '修复后消费' });
    expect(result.accountAvailableBalance).toBe('23570.00');
    expect(await balanceOf()).toBe('23570.00');
    expect(result.consumption.accountId).toBe(CHECKING);
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_broken_active' } })).linkedAccountId).toBe(CHECKING);
  });

  it('repairs straight from consumeCard when the explicit predecessor records a valid account', async () => {
    await insertCard({ id: 'card_unbound_consume', type: 'VIRTUAL', status: 'ACTIVE', numberMasked: '****9003', linkedAccountId: null });
    await insertCard({
      id: 'card_unbound_consume_src',
      type: 'VIRTUAL',
      status: 'LOST',
      numberMasked: '****9004',
      linkedAccountId: CHECKING,
      replacedByCardId: 'card_unbound_consume',
    });

    const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: 'card_unbound_consume', amount: '10.00', merchant: '消费时修复' });

    expect(result.accountAvailableBalance).toBe('23570.00');
    expect(await balanceOf()).toBe('23570.00');
    expect(result.consumption.cardId).toBe('card_unbound_consume');
    expect(result.consumption.accountId).toBe(CHECKING);
    // The recovered binding is written to the row inside the same transaction as the debit.
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_unbound_consume' } })).linkedAccountId).toBe(CHECKING);
  });

  it('refuses an unbound card with NO explicit predecessor instead of guessing a default account', async () => {
    await insertCard({ id: 'card_orphan', type: 'VIRTUAL', status: 'ACTIVE', numberMasked: '****9005', linkedAccountId: null });

    const balanceBefore = await balanceOf();
    const consumptionsBefore = await db().cardConsumption.count();
    const transactionsBefore = await db().transaction.count();

    const error = await capture(() =>
      banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: 'card_orphan', amount: '10.00', merchant: '孤立卡消费' }),
    );
    expectCode(error, 'CONFLICT');

    // No inference, no debit, no ledger row, no consumption, binding still absent.
    expect(await balanceOf()).toBe(balanceBefore);
    expect(await db().cardConsumption.count()).toBe(consumptionsBefore);
    expect(await db().transaction.count()).toBe(transactionsBefore);
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_orphan' } })).linkedAccountId).toBeNull();
  });
});

describe('banking-sdk · CREDIT replacement regression guard', () => {
  it('carries the same approved credit and the dashboard counts it once', async () => {
    const before = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(before.creditLimitMinor).toBe(moneyToCents('18000.00'));
    expect(before.availableLimitMinor).toBe(moneyToCents('18000.00'));

    const dashboardBefore = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(dashboardBefore.creditAvailable).toBe('18000.00');

    await banking.card.reportLostCard(CREDIT, DEMO_USER_ID, { reason: '遗失' });
    const replacement = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);

    // The SAME approved credit travels over — no re-approval, no invented higher allowance.
    const row = await db().card.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(row.type).toBe('CREDIT');
    expect(row.creditLimitMinor).toBe(before.creditLimitMinor);
    expect(row.availableLimitMinor).toBe(before.availableLimitMinor);
    expect(replacement.creditLimit).toBe('18000.00');
    expect(replacement.availableLimit).toBe('18000.00');
    expect(replacement.monthlyLimit).toBe('18000.00');
    // A VIRTUAL-only concern: an unbound CREDIT replacement keeps NO settlement account.
    expect(row.linkedAccountId).toBeNull();

    // Exactly ONE non-LOST CREDIT card carries that allowance (the LOST source is excluded).
    const creditRows = await db().card.findMany({ where: { userId: DEMO_USER_ID, type: 'CREDIT' } });
    expect(creditRows).toHaveLength(2);
    expect(creditRows.filter((card) => card.status !== 'LOST').map((card) => card.id)).toEqual([replacement.id]);

    const dashboardAfter = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(dashboardAfter.creditAvailable).toBe('18000.00');
    expect(dashboardAfter.creditAvailable).toBe(dashboardBefore.creditAvailable);
  });
});
