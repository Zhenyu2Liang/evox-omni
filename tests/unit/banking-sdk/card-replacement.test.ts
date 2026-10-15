/**
 * banking-sdk · card loss / freeze / replacement domain invariants.
 *
 * Pure SDK-level acceptance for Feature 3 (split card loss):
 *   - `reportLostCard` is TERMINAL and idempotent-rejecting (a repeat is a CONFLICT);
 *   - a `LOST` card can neither be frozen nor unfrozen (illegal transition → CONFLICT);
 *   - `freezeCard`/`unfreezeCard` stay REVERSIBLE and idempotent;
 *   - `replaceCard` succeeds ONLY from `LOST`, rejects a foreign card, mints a NEW card with a fresh
 *     masked number owned by the SAME user and same type+network, carries `monthlyLimitMinor` over,
 *     copies NO per-category limits, sets `replacedByCardId` on the source, leaves the source `LOST`
 *     (not revivable), and is idempotent on a second call.
 *
 * Fixtures: demo user 李明; `card_credit` (CREDIT, monthlyLimit ¥18,000, one 娱乐 分类 limit) and
 * `card_debit` (DEBIT, monthlyLimit null). Helpers: ../../helpers/db, ../../helpers/fixtures.
 */
import { describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const db = () => getTestPrisma();
/** CREDIT source: carries a monthly limit (¥18,000) AND one seeded 娱乐 分类 limit (¥3,000). */
const CREDIT = 'card_credit';
/** DEBIT source: no monthly limit, no per-category limits. */
const DEBIT = 'card_debit';
/** A user id that owns none of the demo cards — used to prove the ownership fence. */
const FOREIGN_USER = 'user_intruder';

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

describe('banking-sdk · card freeze / unfreeze', () => {
  it('freeze and unfreeze are reversible and idempotent (a repeat is a no-op, not an error)', async () => {
    expect((await banking.card.freezeCard(DEBIT, DEMO_USER_ID)).status).toBe('FROZEN');
    // Freezing an already-FROZEN card returns the current status untouched.
    expect((await banking.card.freezeCard(DEBIT, DEMO_USER_ID)).status).toBe('FROZEN');

    expect((await banking.card.unfreezeCard(DEBIT, DEMO_USER_ID)).status).toBe('ACTIVE');
    // Unfreezing an already-ACTIVE card is likewise a no-op.
    expect((await banking.card.unfreezeCard(DEBIT, DEMO_USER_ID)).status).toBe('ACTIVE');

    expect((await db().card.findUniqueOrThrow({ where: { id: DEBIT } })).status).toBe('ACTIVE');
  });
});

describe('banking-sdk · report lost is terminal', () => {
  it('a LOST card can neither be frozen nor unfrozen (illegal transition)', async () => {
    expect((await banking.card.reportLostCard(DEBIT, DEMO_USER_ID, { reason: '钱包遗失' })).status).toBe('LOST');

    expectCode(await capture(() => banking.card.freezeCard(DEBIT, DEMO_USER_ID)), 'CONFLICT');
    expectCode(await capture(() => banking.card.unfreezeCard(DEBIT, DEMO_USER_ID)), 'CONFLICT');

    // The illegal transitions never mutated the terminal state.
    expect((await db().card.findUniqueOrThrow({ where: { id: DEBIT } })).status).toBe('LOST');
  });

  it('reporting an already-lost card again is a CONFLICT and the card stays LOST', async () => {
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID, { reason: '丢失' });

    expectCode(await capture(() => banking.card.reportLostCard(DEBIT, DEMO_USER_ID)), 'CONFLICT');
    expect((await db().card.findUniqueOrThrow({ where: { id: DEBIT } })).status).toBe('LOST');
  });
});

describe('banking-sdk · replaceCard eligibility', () => {
  it('rejects any card that is not LOST with a CONFLICT (ACTIVE and FROZEN alike)', async () => {
    expectCode(await capture(() => banking.card.replaceCard(DEBIT, DEMO_USER_ID)), 'CONFLICT');

    await banking.card.freezeCard(DEBIT, DEMO_USER_ID);
    expectCode(await capture(() => banking.card.replaceCard(DEBIT, DEMO_USER_ID)), 'CONFLICT');

    // No replacement was minted by a rejected call.
    expect((await db().card.findUniqueOrThrow({ where: { id: DEBIT } })).replacedByCardId).toBeNull();
  });

  it('rejects a card that the user does not own without minting a replacement', async () => {
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID);

    expectCode(await capture(() => banking.card.replaceCard(DEBIT, FOREIGN_USER)), 'SECURITY_DENIED');
    expect((await db().card.findUniqueOrThrow({ where: { id: DEBIT } })).replacedByCardId).toBeNull();
  });
});

describe('banking-sdk · replaceCard mints a NEW linked card', () => {
  it('mints a fresh-masked card: same owner/type/network, monthly limit carried over, NO per-category limits', async () => {
    const existingMasks = new Set(
      (await db().card.findMany({ where: { userId: DEMO_USER_ID } })).map((card) => card.numberMasked),
    );
    // The CREDIT source carries a seeded 娱乐 分类 limit — the replacement must NOT copy it.
    expect(await db().cardLimit.count({ where: { cardId: CREDIT } })).toBe(1);

    await banking.card.reportLostCard(CREDIT, DEMO_USER_ID, { reason: '遗失' });
    const replacement = await banking.card.replaceCard(CREDIT, DEMO_USER_ID);

    // A brand-new row with a fresh masked number (never a duplicate of an existing mask).
    expect(replacement.id).not.toBe(CREDIT);
    expect(replacement.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(replacement.numberMasked).not.toBe('****6688');
    expect(existingMasks.has(replacement.numberMasked)).toBe(false);

    // Same owner, same type + network, ACTIVE.
    const row = await db().card.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(row.userId).toBe(DEMO_USER_ID);
    expect(row.type).toBe('CREDIT');
    expect(row.network).toBe('UnionPay');
    expect(row.status).toBe('ACTIVE');

    // The source's monthly limit is carried over exactly.
    expect(replacement.monthlyLimit).toBe('18000.00');
    expect(row.monthlyLimitMinor).toBe(moneyToCents('18000.00'));

    // Per-category limits are NOT copied onto the new card.
    expect(replacement.limits).toEqual([]);
    expect(await db().cardLimit.count({ where: { cardId: replacement.id } })).toBe(0);

    // The source records the new card id and STAYS LOST (never revived).
    const source = await db().card.findUniqueOrThrow({ where: { id: CREDIT } });
    expect(source.status).toBe('LOST');
    expect(source.replacedByCardId).toBe(replacement.id);
    expectCode(await capture(() => banking.card.unfreezeCard(CREDIT, DEMO_USER_ID)), 'CONFLICT');

    // A replacement never invents credit: the CREDIT-typed replacement holds no credit fields.
    expect(replacement.creditLimit).toBeUndefined();
    expect(replacement.availableLimit).toBeUndefined();
    expect(row.creditLimitMinor).toBeNull();
    expect(row.availableLimitMinor).toBeNull();
  });

  it('leaves the monthly limit absent when the source has none (DEBIT)', async () => {
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID);
    const replacement = await banking.card.replaceCard(DEBIT, DEMO_USER_ID);

    expect(replacement.type).toBe('DEBIT');
    expect(replacement.monthlyLimit).toBeUndefined();
    expect((await db().card.findUniqueOrThrow({ where: { id: replacement.id } })).monthlyLimitMinor).toBeNull();
  });

  it('is idempotent: a second call returns the same replacement without minting a second card', async () => {
    await banking.card.reportLostCard(DEBIT, DEMO_USER_ID);
    const first = await banking.card.replaceCard(DEBIT, DEMO_USER_ID);
    const countAfterFirst = await db().card.count({ where: { userId: DEMO_USER_ID } });

    const second = await banking.card.replaceCard(DEBIT, DEMO_USER_ID);

    expect(second.id).toBe(first.id);
    expect(second.numberMasked).toBe(first.numberMasked);
    // No second mint: the card count is unchanged and the source still points at ONE replacement.
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(countAfterFirst);
    expect((await db().card.findUniqueOrThrow({ where: { id: DEBIT } })).replacedByCardId).toBe(first.id);
  });
});
