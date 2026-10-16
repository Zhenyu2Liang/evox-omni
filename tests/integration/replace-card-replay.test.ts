/**
 * tests/integration/replace-card-replay.test.ts — ORIGINAL-OPERATION idempotent replay (原操作幂等重放)
 * for the `replace_card` write.
 *
 * INVARIANT UNDER TEST (root CONTEXT.md): "Receipts match owner, tool and normalized arguments and
 * replay original responses before mutable lookup." `replace_card` is a 🔴 RED write
 * (`lib/contracts/tool-catalog.ts`: `replay: { safety:'idempotent', maxAttempts:3, requiresReceipt:true }`)
 * whose SDK mutation (`banking-sdk/card.ts#replaceCard`) accepts NO idempotency key: at-most-once for
 * the AGENT comes ONLY from the receipt layer, keyed by the server-owned operation key. That lookup
 * (`agent/command-execution.ts#readCommandReceipt`, called by `executeBankingCommand`) runs BEFORE any
 * mutable lookup, write fence or gateway, so a replay of the SAME operation returns the ORIGINAL
 * committed response and never re-enters the write boundary (no new card, no new audit, no new
 * confirmation/MFA, no new tool call).
 *
 * HOW THIS RELATES TO THE LIVE `lA` SCENARIO (tests/e2e/live-acceptance.e2e.ts#scenarioCreditReplace):
 * that live-browser scenario reports the demo credit card lost and replaces it through `/agent` + MFA,
 * then claims TWO different things about a second `replace_card`:
 *   (a) MODEL BEHAVIOUR — a second natural-language request through the chat must not mint a second
 *       card. Whether the live model parks the MFA card again is a model-stability claim and stays a
 *       live-only claim (`tests/e2e/CONTEXT.md`).
 *   (b) ORIGINAL-OPERATION REPLAY — re-issuing the SAME operation returns the ORIGINAL response with no
 *       second card and no new MFA/tool call. THIS file pins (b) deterministically: no model, no
 *       browser, real registry + real SQLite only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDemoSession, type ToolExecutionResult } from '@/agent';
import { createToolRegistry } from '@/agent/tools';
import { writeAuditKey } from '@/agent/write-audit';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

/** The seeded credit card is the `lA` subject: same owner, network and ¥18,000 credit limit. */
const SOURCE_CARD_ID = 'card_credit';
const SOURCE_NUMBER_MASKED = '****6688';
const CREDIT_LIMIT = '18000.00';
/** The server-owned operation key of the ORIGINAL request (a review identity, not a model value). */
const OPERATION_KEY = 'review:replace_card:replay';

const database = () => getTestPrisma();

/** The `CardView` subset this regression reads (see `banking-sdk/types.ts`). */
interface CardView {
  id: string;
  type: string;
  network: string;
  numberMasked: string;
  status: string;
  creditLimit?: string;
  availableLimit?: string;
  monthlyLimit?: string;
  replacedByCardId?: string;
  limits: Array<{ category: string; amount: string }>;
}

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/**
 * The fixtures seed BOTH cards `ACTIVE` (no LOST card exists), while `replaceCard` requires a source in
 * `LOST` and refuses anything else with `CONFLICT`. Put the source into that precondition directly.
 */
async function markSourceLost(): Promise<void> {
  await database().card.update({ where: { id: SOURCE_CARD_ID }, data: { status: 'LOST' } });
}

/** The persisted truth of a committed `replace_card` — the source stays LOST and points at the new card. */
async function expectSourceLinkedTo(replacementCardId: string): Promise<void> {
  const source = await database().card.findUniqueOrThrow({ where: { id: SOURCE_CARD_ID } });
  expect(source).toMatchObject({ status: 'LOST', numberMasked: SOURCE_NUMBER_MASKED, replacedByCardId: replacementCardId });
  // Per-category limits are NOT copied to the replacement, so the source keeps its own row.
  expect(await database().cardLimit.count({ where: { cardId: SOURCE_CARD_ID } })).toBe(1);
}

/** Cards owned by the demo user / ACTIVE credit cards — the counts the live `lA` scenario also asserts. */
const userCardCount = () => database().card.count({ where: { userId: DEMO_USER_ID } });
const activeCreditCardCount = () =>
  database().card.count({ where: { userId: DEMO_USER_ID, type: 'CREDIT', status: 'ACTIVE' } });

/** The single write-audit row of the ORIGINAL operation identity. */
const originalWriteAuditCount = () =>
  database().auditLog.count({ where: { dedupeKey: writeAuditKey('replace_card', DEMO_USER_ID, OPERATION_KEY) } });

/** A committed `replace_card` result, narrowed to its card view. */
function committedCardView(result: ToolExecutionResult): CardView {
  expect(result.ok).toBe(true);
  expect(result.summary).toContain('补办');
  return result.data as CardView;
}

/**
 * A mask guaranteed to differ from `committed` — the masked number is RANDOMLY generated
 * (`banking-sdk/card.ts#generateMaskedNumber`), so no literal value may ever be asserted.
 */
function differentMask(committed: string): string {
  return committed === '****0000' ? '****1111' : '****0000';
}

describe('replace_card replays its original committed response (原操作幂等重放)', () => {
  it('returns the original response for the same operation key without a second card, MFA or write fence', async () => {
    const db = database();
    await markSourceLost();
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const options = { sessionId, idempotencyKey: OPERATION_KEY };

    // `executeDirect` is the MODEL-FREE path: it never runs the security gateway, so no gated action
    // exists before — and therefore none can appear after a replay.
    expect(await db.pendingAction.count()).toBe(0);
    expect(await db.mfaChallenge.count()).toBe(0);

    // (1) ORIGINAL request: exactly one new replacement card, one immutable receipt, one audit.
    const original = await createToolRegistry(DEMO_USER_ID)
      .executeDirect('replace_card', { cardId: SOURCE_CARD_ID }, options);
    const card = committedCardView(original);
    expect(card.id).not.toBe(SOURCE_CARD_ID);
    expect(card).toMatchObject({
      type: 'CREDIT',
      network: 'UnionPay',
      status: 'ACTIVE',
      creditLimit: CREDIT_LIMIT,
      availableLimit: CREDIT_LIMIT,
      monthlyLimit: CREDIT_LIMIT,
      limits: [],
    });
    expect(card.replacedByCardId).toBeUndefined();
    await expectSourceLinkedTo(card.id);
    expect(await userCardCount()).toBe(3);
    expect(await activeCreditCardCount()).toBe(1);
    const receipt = await db.executionReceipt.findUniqueOrThrow({
      where: { userId_key: { userId: DEMO_USER_ID, key: OPERATION_KEY } },
    });
    expect(receipt.toolName).toBe('replace_card');
    expect(JSON.parse(receipt.responseJson!)).toEqual(original);
    expect(await originalWriteAuditCount()).toBe(1);

    // (2) Change MUTABLE state the response mentions, exactly as a later card edit would. A replay that
    // re-derived its answer from the current row would report THIS mask instead of the committed one.
    const mutatedMask = differentMask(card.numberMasked);
    expect(mutatedMask).not.toBe(card.numberMasked);
    await db.card.update({ where: { id: card.id }, data: { numberMasked: mutatedMask } });

    // (3) REPLAY the SAME operation behind a REAL write fence that fails if it is ever entered.
    const fence = vi.fn(async () => {
      throw new Error('the write fence must not be entered when replaying a committed operation');
    });
    const replay = await createToolRegistry(DEMO_USER_ID)
      .executeDirect('replace_card', { cardId: SOURCE_CARD_ID }, { ...options, fence });

    expect(replay).toEqual(original);
    expect((replay.data as CardView).numberMasked).toBe(card.numberMasked);
    expect(fence).not.toHaveBeenCalled();
    expect(await userCardCount()).toBe(3);
    expect(await activeCreditCardCount()).toBe(1);
    await expectSourceLinkedTo(card.id);
    expect(await db.executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
    expect(await originalWriteAuditCount()).toBe(1);
    // Still no gated action and no challenge: a replay neither prompts nor mints an MFA challenge.
    expect(await db.pendingAction.count()).toBe(0);
    expect(await db.mfaChallenge.count()).toBe(0);
  });

  it('still issues no second card under a FRESH operation key, which does go through the write fence', async () => {
    const db = database();
    await markSourceLost();
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const original = await createToolRegistry(DEMO_USER_ID)
      .executeDirect('replace_card', { cardId: SOURCE_CARD_ID }, { sessionId, idempotencyKey: OPERATION_KEY });
    const card = committedCardView(original);
    const mutatedMask = differentMask(card.numberMasked);
    await db.card.update({ where: { id: card.id }, data: { numberMasked: mutatedMask } });

    // A new operation key is a NEW command, not a replay: it is fenced and reports live mutable state.
    const fence = vi.fn(async () => {});
    const second = await createToolRegistry(DEMO_USER_ID).executeDirect('replace_card', { cardId: SOURCE_CARD_ID },
      { sessionId, idempotencyKey: `${OPERATION_KEY}:fresh`, fence });
    expect(fence).toHaveBeenCalledTimes(1);
    const secondCard = committedCardView(second);
    expect(secondCard.id).toBe(card.id);
    expect(secondCard.numberMasked).toBe(mutatedMask);
    // At-most-once for the CARD comes from `replaceCard`'s in-transaction check; at-most-once for the
    // COMMAND comes from the receipt layer — so each identity has its own receipt and audit row.
    expect(await userCardCount()).toBe(3);
    expect(await activeCreditCardCount()).toBe(1);
    await expectSourceLinkedTo(card.id);
    expect(await db.executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(2);
    expect(await db.auditLog.count({ where: { sessionId, toolName: 'replace_card' } })).toBe(2);
  });

  it('matches owner, tool and normalized arguments before replaying: another argument or tool is a conflict', async () => {
    const db = database();
    await markSourceLost();
    const { sessionId } = await getDemoSession(DEMO_USER_ID);
    const options = { sessionId, idempotencyKey: OPERATION_KEY };
    const original = await createToolRegistry(DEMO_USER_ID)
      .executeDirect('replace_card', { cardId: SOURCE_CARD_ID }, options);
    const card = committedCardView(original);
    const fence = vi.fn(async () => {
      throw new Error('a conflicting command must not reach the write boundary');
    });

    // Same owner + same identity, CHANGED argument …
    await expect(createToolRegistry(DEMO_USER_ID)
      .executeDirect('replace_card', { cardId: 'card_debit' }, { ...options, fence }))
      .resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    // … and CHANGED tool under the same identity.
    await expect(createToolRegistry(DEMO_USER_ID)
      .executeDirect('report_lost_card', { cardId: SOURCE_CARD_ID, reason: 'replay attempt' }, { ...options, fence }))
      .resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT' });

    expect(fence).not.toHaveBeenCalled();
    expect(await userCardCount()).toBe(3);
    expect(await activeCreditCardCount()).toBe(1);
    expect((await db.card.findUniqueOrThrow({ where: { id: 'card_debit' } })).status).toBe('ACTIVE');
    await expectSourceLinkedTo(card.id);
    expect(await db.executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
    expect(await originalWriteAuditCount()).toBe(1);
  });
});
