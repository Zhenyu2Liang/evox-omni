/**
 * tests/integration/card-replacement-transaction.test.ts — SQLite-backed regressions for the 补办
 * (`replaceCard`) TRANSACTION BOUNDARY and for the SETTLEMENT-BINDING validation of a VIRTUAL card.
 *
 * INVARIANTS UNDER TEST (root CONTEXT.md):
 *  - "A VIRTUAL card is a debit instrument bound to one owned CHECKING account." Its spendable
 *    amount is `min(account cash, remaining monthly limit)` — a card with no usable binding can
 *    never spend, so `banking-sdk/card.ts#replaceCard` RE-VALIDATES the predecessor's recorded
 *    `linkedAccountId` (row must exist, be owned by `userId`, be `CHECKING`) inside the replacement
 *    transaction and refuses a broken source with `CONFLICT`. A broken binding is NEVER repaired
 *    from a guessed default account.
 *  - The 补办 unit is ALL-OR-NOTHING: the replacement row is minted (`card.create`) and the source
 *    is linked afterwards (`card.update`) in ONE interactive transaction, so a failure between the
 *    two leaves NO half-written replacement and NO dangling pointer.
 *  - The idempotent replay branch (a source that already points at a replacement) runs AFTER the
 *    binding validation, so it can neither hand back a dead card nor "repair" it from a link that
 *    is itself broken; when the source's binding is still valid it restores the missing binding
 *    ONLY from that explicit source link.
 *
 * WHY THESE ASSERTIONS LIVE HERE (not in `tests/unit/banking-sdk/card-replacement.test.ts`):
 * that suite pins the CREDIT carry-over/idempotency shape. This file drives the REAL SDK against the
 * REAL SQLite test database for the VIRTUAL-specific, transaction-safety half of the fix — including
 * a genuine rollback through `tests/helpers/write-failure.ts` (the real `$transaction` is used, so
 * the earlier write genuinely rolls back) and a source boundary that has drifted in three ways.
 *
 * Fixtures: demo user 李明; `acct_checking` CHECKING ¥23,580.00 (the default settlement account),
 * `acct_savings` SAVINGS ¥50,000.00, `card_credit` + `card_debit`. NO VIRTUAL card and NO `LOST`
 * card is seeded, so every VIRTUAL source is issued here.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { withInjectedWriteFailure } from '@/tests/helpers/write-failure';

/** The demo user's default settlement account (CHECKING ¥23,580.00). */
const CHECKING = 'acct_checking';
/** The user's OWN second account — a SAVINGS row, so it can never settle a virtual card. */
const SAVINGS = 'acct_savings';
/** Monthly limit configured on every VIRTUAL source issued here (CNY). */
const VIRTUAL_MONTHLY_LIMIT = '2000.00';
/** An account id with no row at all — an account deleted out from under a recorded binding. */
const MISSING_ACCOUNT = 'acct_deleted_out_from_under_the_card';
/** A second user + CHECKING account, so a card can drift onto an account it does not own. */
const FOREIGN_USER_ID = 'user_replace_txn_foreign';
const FOREIGN_CHECKING = 'acct_foreign_checking';

const db = () => getTestPrisma();

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** Cards owned by the demo user — the 2 seeded rows plus whatever this spec issued. */
const userCardCount = () => db().card.count({ where: { userId: DEMO_USER_ID } });

/** The raw persisted row (never the enriched DTO) — exact assertions live on this. */
const rawCard = (cardId: string) => db().card.findUniqueOrThrow({ where: { id: cardId } });

/** Issue a VIRTUAL card for the demo user, bound by default to the default CHECKING account. */
async function issueVirtualCard(): Promise<{ id: string }> {
  return banking.card.applyVirtualCard({
    userId: DEMO_USER_ID,
    monthlyLimit: VIRTUAL_MONTHLY_LIMIT,
  });
}

/** Move an owned card to the terminal `LOST` state through the real SDK path. */
async function reportLost(cardId: string): Promise<void> {
  await banking.card.reportLostCard(cardId, DEMO_USER_ID, { reason: '卡片遗失，需要补办' });
}

/** Await `fn`, returning whatever it rejected with; fail loudly if it unexpectedly resolves. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** Assert the rejection is an `AppError` with the expected domain code and message, and return it. */
function expectAppError(error: unknown, code: string, message: RegExp): AppError {
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe(code);
  expect(appError.message).toMatch(message);
  return appError;
}

describe('replaceCard is ONE transaction: a failed 补办 leaves no half-written card', () => {
  it('mints exactly one VIRTUAL replacement that inherits the re-validated settlement binding', async () => {
    const source = await issueVirtualCard();
    await reportLost(source.id);
    expect(await userCardCount()).toBe(3);
    const limitsBefore = await db().cardLimit.count();

    const replacement = await banking.card.replaceCard(source.id, DEMO_USER_ID);

    // A brand-new row: same owner/type/network, ACTIVE, fresh mask, monthly limit carried over.
    expect(replacement.id).not.toBe(source.id);
    expect(replacement.type).toBe('VIRTUAL');
    expect(replacement.status).toBe('ACTIVE');
    expect(replacement.network).toBe('UnionPay');
    expect(replacement.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(replacement.monthlyLimit).toBe(VIRTUAL_MONTHLY_LIMIT);

    const row = await rawCard(replacement.id);
    expect(row.userId).toBe(DEMO_USER_ID);
    expect(row.monthlyLimitMinor).toBe(moneyToCents(VIRTUAL_MONTHLY_LIMIT));
    // The binding survives the 补办: the new card spends from the SAME cash as its predecessor …
    expect(row.linkedAccountId).toBe(CHECKING);
    expect(replacement.linkedAccountId).toBe(CHECKING);
    expect(replacement.linkedAccountNumber).toBe('****8821');
    expect(replacement.accountAvailableBalance).toBe('23580.00');
    // … so its payable amount is `min(account cash, remaining monthly limit)` = the limit here.
    expect(replacement.payableAmount).toBe(VIRTUAL_MONTHLY_LIMIT);

    // The source stays terminal (LOST) and merely records the historical pointer.
    expect(await rawCard(source.id)).toMatchObject({
      status: 'LOST',
      replacedByCardId: replacement.id,
      linkedAccountId: CHECKING,
    });
    expect(await userCardCount()).toBe(4);
    // Per-category limits are not copied and a 补办 books no spend.
    expect(await db().cardLimit.count()).toBe(limitsBefore);
    expect(await db().cardConsumption.count()).toBe(0);
  });

  it('rolls the already-minted replacement row back when the source link fails (no orphan card)', async () => {
    const source = await issueVirtualCard();
    // Reported lost BEFORE the injection: the injected failure must target the 补办 only.
    await reportLost(source.id);

    const countBefore = await userCardCount();
    const masksBefore = new Set(
      (await db().card.findMany({ where: { userId: DEMO_USER_ID } })).map((card) => card.numberMasked),
    );
    const limitsBefore = await db().cardLimit.count();
    expect(countBefore).toBe(3);
    // Precondition: the source is LOST with NO replacement yet, so this call really does mint one.
    expect(await rawCard(source.id)).toMatchObject({
      status: 'LOST',
      type: 'VIRTUAL',
      linkedAccountId: CHECKING,
      replacedByCardId: null,
    });

    /**
     * WRITE ORDER — verified against `banking-sdk/card.ts#replaceCard` (lines 460–507) and pinned
     * empirically by the contrast with the un-injected control `it` above: the VIRTUAL branch
     * re-reads the source (460–474), `tx.card.create(...)` mints the replacement (491), and only
     * THEN does `tx.card.update(...)` link it on the source (505) — the FIRST `card.update` of the
     * unit, because `requireSettlementAccount` only reads `account` and the idempotent branch (475)
     * is skipped while `replacedByCardId` is null. So the injected failure hits the SECOND write,
     * after the replacement row already exists inside the real transaction: exactly the half-written
     * state a non-atomic implementation would leak. The assertion below that the message names
     * `card.update` proves the injected method was actually reached (a test that never reached the
     * second write would surface no error at all, since the call would resolve instead of reject).
     * The CREDIT twin of this ordering case lives in
     * `tests/unit/banking-sdk/card-replacement.test.ts` ("rolls back a partially-written
     * replacement"), which injects the same `card.update` failure.
     */
    const error = await capture(() =>
      withInjectedWriteFailure('card', 'update', () => banking.card.replaceCard(source.id, DEMO_USER_ID)),
    );

    // Surfaced, never swallowed — an injected infrastructure failure is not a domain outcome.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/injected failure: card\.update/);

    // The created replacement was rolled back with it: no new card, no orphan mask.
    expect(await userCardCount()).toBe(countBefore);
    expect(new Set((await db().card.findMany({ where: { userId: DEMO_USER_ID } })).map((card) => card.numberMasked)))
      .toEqual(masksBefore);
    // No card of the user points at a replacement of the source, in either direction.
    expect(await db().card.count({ where: { replacedByCardId: source.id } })).toBe(0);

    // The source is untouched: still LOST, still unlinked, still bound to its settlement account.
    expect(await rawCard(source.id)).toMatchObject({
      status: 'LOST',
      replacedByCardId: null,
      linkedAccountId: CHECKING,
      monthlyLimitMinor: moneyToCents(VIRTUAL_MONTHLY_LIMIT),
    });

    // The card-addressed child tables gained nothing either.
    expect(await db().cardConsumption.count()).toBe(0);
    expect(await db().cardLimit.count()).toBe(limitsBefore);
  });
});

/** A drifted binding: what `linkedAccountId` records and how `requireSettlementAccount` must answer. */
interface DriftCase {
  label: string;
  accountId: string;
  prepare: () => Promise<void>;
  message: RegExp;
}

/** Create the foreign user + their CHECKING account (no card, so it can never settle as owner). */
async function seedForeignCheckingAccount(): Promise<void> {
  await db().user.create({ data: { id: FOREIGN_USER_ID, name: '外籍用户', phone: '13000000000' } });
  await db().account.create({ data: {
    id: FOREIGN_CHECKING,
    userId: FOREIGN_USER_ID,
    type: 'CHECKING',
    name: '活期账户',
    number: '****9001',
    balanceMinor: moneyToCents('8888.00'),
  } });
}

const DRIFT_CASES: readonly DriftCase[] = [
  {
    label: 'a CHECKING account owned by ANOTHER user',
    accountId: FOREIGN_CHECKING,
    prepare: seedForeignCheckingAccount,
    message: /不存在或不属于该用户/,
  },
  {
    label: "the user's own SAVINGS account",
    accountId: SAVINGS,
    prepare: async () => {},
    message: /不是活期账户/,
  },
  {
    label: 'an account id that has no row',
    accountId: MISSING_ACCOUNT,
    prepare: async () => {},
    message: /不存在或不属于该用户/,
  },
];

describe('replaceCard refuses a source whose settlement binding has drifted', () => {
  it.each(DRIFT_CASES)(
    'throws CONFLICT and mints NO card when the lost VIRTUAL card is bound to $label',
    async (drift) => {
      await drift.prepare();
      const source = await issueVirtualCard();
      await reportLost(source.id);
      // `Card.linkedAccountId` is a historical reference, not a relation: the account can drift out
      // from under it. Record the drift directly, exactly as a deleted/re-typed account would.
      await db().card.update({ where: { id: source.id }, data: { linkedAccountId: drift.accountId } });

      const countBefore = await userCardCount();
      const limitsBefore = await db().cardLimit.count();
      expect(countBefore).toBe(3);

      const error = await capture(() => banking.card.replaceCard(source.id, DEMO_USER_ID));
      const appError = expectAppError(error, 'CONFLICT', drift.message);
      // The diagnostic names the card and the offending binding — never a guessed replacement.
      expect(appError.detail).toMatchObject({ cardId: source.id });

      // NOTHING was minted: the user's card count is unchanged …
      expect(await userCardCount()).toBe(countBefore);
      // … no non-source row claims to be a replacement of this source …
      expect(await db().card.count({ where: { replacedByCardId: source.id } })).toBe(0);
      // … and the source itself keeps no pointer to a phantom replacement.
      const sourceAfter = await rawCard(source.id);
      expect(sourceAfter).toMatchObject({ status: 'LOST', replacedByCardId: null });
      // NO "repair" to a default account happened: the recorded binding is exactly what drifted in.
      expect(sourceAfter.linkedAccountId).toBe(drift.accountId);
      // And no card at all was silently re-created against the default CHECKING account.
      expect(await db().card.count({ where: { userId: DEMO_USER_ID, linkedAccountId: CHECKING } })).toBe(0);

      expect(await db().cardConsumption.count()).toBe(0);
      expect(await db().cardLimit.count()).toBe(limitsBefore);
    },
  );

  it('throws CONFLICT instead of minting when a lost VIRTUAL card has NO recorded binding at all', async () => {
    const source = await issueVirtualCard();
    await reportLost(source.id);
    await db().card.update({ where: { id: source.id }, data: { linkedAccountId: null } });
    const countBefore = await userCardCount();

    const error = await capture(() => banking.card.replaceCard(source.id, DEMO_USER_ID));
    expectAppError(error, 'CONFLICT', /未绑定结算账户/);

    expect(await userCardCount()).toBe(countBefore);
    expect(await db().card.count({ where: { replacedByCardId: source.id } })).toBe(0);
    expect((await rawCard(source.id)).linkedAccountId).toBeNull();
    // No default account was guessed in.
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, linkedAccountId: CHECKING } })).toBe(0);
  });
});

describe('the idempotent replay branch of replaceCard cannot hand back a dead VIRTUAL card', () => {
  /**
   * A `LOST` VIRTUAL source that ALREADY points at a replacement whose binding is missing — the
   * shape a replacement minted before bindings were inherited leaves behind.
   */
  async function legacyReplacementState(): Promise<{ sourceId: string; replacementId: string }> {
    const source = await issueVirtualCard();
    await reportLost(source.id);
    const replacement = await banking.card.replaceCard(source.id, DEMO_USER_ID);
    await db().card.update({ where: { id: replacement.id }, data: { linkedAccountId: null } });
    expect(await rawCard(replacement.id)).toMatchObject({ type: 'VIRTUAL', linkedAccountId: null, status: 'ACTIVE' });
    return { sourceId: source.id, replacementId: replacement.id };
  }

  it('repairs the missing binding from the EXPLICIT source link when that link is still valid', async () => {
    const { sourceId, replacementId } = await legacyReplacementState();
    const countBefore = await userCardCount();
    expect(countBefore).toBe(4);

    const replay = await banking.card.replaceCard(sourceId, DEMO_USER_ID);

    // The idempotent branch returns the SAME replacement (never a second mint) …
    expect(replay.id).toBe(replacementId);
    expect(await userCardCount()).toBe(countBefore);
    // … and it is now usable: the binding was restored from the source's own recorded link.
    expect(replay.linkedAccountId).toBe(CHECKING);
    expect(replay.linkedAccountNumber).toBe('****8821');
    expect((await rawCard(replacementId)).linkedAccountId).toBe(CHECKING);
    // The restored card is spendable again — `min(¥23,580.00 cash, ¥2,000.00 limit)`.
    expect(replay.payableAmount).toBe(VIRTUAL_MONTHLY_LIMIT);
    expect(replay.accountAvailableBalance).toBe(centsToMoney(moneyToCents('23580.00')));
    // The source still points at it and stays LOST.
    expect(await rawCard(sourceId)).toMatchObject({ status: 'LOST', replacedByCardId: replacementId });
  });

  it('rejects instead of returning it when the source link it would repair from is itself broken', async () => {
    const { sourceId, replacementId } = await legacyReplacementState();
    // The source's own binding drifted AFTER the replacement was minted (e.g. the account was
    // re-typed). The repair source is therefore unusable, so the branch must not guess a default.
    await db().card.update({ where: { id: sourceId }, data: { linkedAccountId: SAVINGS } });
    const countBefore = await userCardCount();

    const error = await capture(() => banking.card.replaceCard(sourceId, DEMO_USER_ID));

    // The binding validation runs BEFORE the idempotent return (card.ts:466–489), so the replay is
    // refused rather than answered with a card that has no usable binding.
    expectAppError(error, 'CONFLICT', /不是活期账户/);
    // The existing replacement was NOT repaired from the broken link and NOT bound to a default.
    expect((await rawCard(replacementId)).linkedAccountId).toBeNull();
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, linkedAccountId: CHECKING } })).toBe(0);
    // No second mint, and the source keeps both its pointer and its (drifted) binding verbatim.
    expect(await userCardCount()).toBe(countBefore);
    expect(await rawCard(sourceId)).toMatchObject({
      status: 'LOST',
      replacedByCardId: replacementId,
      linkedAccountId: SAVINGS,
    });
    expect(await db().cardConsumption.count()).toBe(0);
  });
});
