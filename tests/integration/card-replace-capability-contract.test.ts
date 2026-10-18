/**
 * tests/integration/card-replace-capability-contract.test.ts — the `replace_card` (补办)
 * CAPABILITY CONTRACT through the REAL gateway → SDK → SQLite path: no model, no HTTP, no browser.
 *
 * INVARIANTS UNDER TEST (root CONTEXT.md + `lib/contracts/tool-catalog.ts` + `banking-sdk/card.ts`):
 *
 *  (1) THE CAPABILITY IS REACHABLE FOR EVERY CARD TYPE. `replace_card` is a model-exposed 🔴 RED write
 *      (`authorization: 'static'`, `requiresReceipt`), so the ONLY way it can spend a card is a REAL
 *      `PendingAction` whose persisted MFA requirement is `true`, followed by a human verification that
 *      executes the ORIGINAL parked arguments. Until that decision lands, 补办 has NO effect at all: no
 *      card row is created, no card status changes and no `replacedByCardId` link appears. This file pins
 *      the whole reachability chain (CREDIT, DEBIT and VIRTUAL) instead of the SDK function in isolation
 *      — `card-replacement-binding.test.ts` covers the SDK/binding mechanics, not the gated path.
 *
 *  (2) A SOURCE THAT IS NOT `LOST` IS REFUSED, NOT "REPAIRED". The precondition is checked by the
 *      server at command time, and a refusal must leave the persisted row EXACTLY as it was: a card that
 *      was `ACTIVE`/`FROZEN` stays `ACTIVE`/`FROZEN` (it is never silently reported lost first), keeps
 *      no `replacedByCardId`, and no second card exists. The refusal is a `CONFLICT` on a `failed`
 *      decision — never an `executed` one.
 *
 *  (3) A DUPLICATE REQUEST CANNOT BECOME A SECOND 补办. Two decisions over the same source resolve to the
 *      SAME replacement card (the SDK returns the existing `replacedByCardId` target and mints nothing),
 *      and a replay of the SAME server-owned execution key returns the ORIGINAL committed response
 *      without entering the write fence — the receipt layer, not the model, owns at-most-once.
 *
 * Deterministic: no model, no browser, no HTTP; the only clock seam used is the existing `demoNow()`
 * business clock that `banking-sdk/card#consumeCard` books a spend with. Every monetary value is asserted
 * as an exact canonical CNY decimal string or integer minor units — never a float — and the masked card
 * number is RANDOMLY generated, so no literal mask is ever asserted for a new card (only its shape, that
 * it differs from the source, and that nothing else changed).
 *
 * Fixtures: demo user 李明, `acct_checking` CHECKING ¥23,580.00 (mask `****8821`), `card_credit` (CREDIT,
 * mask `****6688`, credit limit ¥18,000.00) and `card_debit` (DEBIT), both seeded `ACTIVE`. NO `LOST` card
 * and NO VIRTUAL card is seeded, so every source here is put into its precondition through the REAL SDK
 * (`banking.card.reportLostCard` / `banking.card.applyVirtualCard`) rather than by rewriting rows.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeGatedTool, getDemoSession, verifyAction } from '@/agent';
import { createToolRegistry } from '@/agent/tools';
import { banking } from '@/banking-sdk';
import { cardFamilyMonthSpend } from '@/banking-sdk/card-family';
import type { CardView } from '@/banking-sdk/types';
import { demoNow } from '@/lib/clock';
import { MFA_CODE } from '@/lib/constants';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

/** The only seeded settlement account (the default CHECKING target of a VIRTUAL card). */
const CHECKING = 'acct_checking';
/** Its masked number, exposed on the enriched `CardView` as `linkedAccountNumber`. */
const CHECKING_NUMBER = '****8821';

const db = () => getTestPrisma();

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** The persisted card columns this contract reads — identity, status and exact minor-unit money. */
interface CardRowSnapshot {
  id: string;
  type: string;
  status: string;
  numberMasked: string;
  replacedByCardId: string | null;
  creditLimitMinor: bigint | null;
  availableLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  linkedAccountId: string | null;
}

/**
 * Fingerprint of EVERY card of the demo user. Comparing two fingerprints is how this file asserts
 * "nothing minted, nothing flipped, nothing re-attributed": new rows show up, a status change shows up,
 * and a gained `replacedByCardId` shows up — all without hardcoding a whole-DB card count.
 */
function cardWorld(): Promise<CardRowSnapshot[]> {
  return db().card.findMany({
    where: { userId: DEMO_USER_ID },
    orderBy: { id: 'asc' },
    select: {
      id: true, type: true, status: true, numberMasked: true, replacedByCardId: true,
      creditLimitMinor: true, availableLimitMinor: true, monthlyLimitMinor: true, linkedAccountId: true,
    },
  });
}

const cardRow = (cardId: string) => db().card.findUniqueOrThrow({ where: { id: cardId } });

/** The shared demo conversation — persisted (`demo:${userId}`), so ownership checks have a real target. */
async function gatewaySession(): Promise<string> {
  return (await getDemoSession(DEMO_USER_ID)).sessionId;
}

/**
 * Park `replace_card` through the REAL security gateway (model-free `executeGatedTool` → `handleToolCall`
 * → persisted `PendingAction`). Returns the id of the decision the human must now make.
 */
async function parkReplace(sessionId: string, cardId: string): Promise<string> {
  const outcome = await executeGatedTool({
    userId: DEMO_USER_ID, sessionId, toolName: 'replace_card',
    args: { cardId }, userRequest: `补办挂失的卡片 ${cardId}`,
  });
  expect(outcome.requiresConfirmation).toBe(true);
  expect(outcome.pendingActionId).toBeTruthy();
  expect(outcome.ok).toBe(false);
  return outcome.pendingActionId!;
}

/** The persisted RED decision: strong verification required, original args parked, nothing executed. */
async function expectAwaitingMfa(actionId: string, cardId: string): Promise<void> {
  const row = await db().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
  expect(row).toMatchObject({
    toolName: 'replace_card', status: 'awaiting_mfa', riskLevel: 'RED', requiresMfa: true, resultJson: null,
  });
  expect(JSON.parse(row.argsJson)).toMatchObject({ cardId });
}

/** The human decision: MFA-verify the parked action, which executes its ORIGINAL arguments. */
function approve(sessionId: string, actionId: string) {
  return verifyAction(actionId, MFA_CODE, { userId: DEMO_USER_ID, sessionId });
}

/** The ONE replacement a committed 补办 produced — read from the source's historical link. */
async function replacementOf(sourceId: string) {
  const source = await cardRow(sourceId);
  expect(source.status).toBe('LOST');
  expect(source.replacedByCardId).toBeTruthy();
  return cardRow(source.replacedByCardId!);
}

/** Issue a VIRTUAL card through the real SDK (default settlement binding = `acct_checking`). */
function issueVirtualCard(monthlyLimit: string): Promise<CardView> {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, monthlyLimit });
}

/** Put a card into the 补办 precondition through the REAL terminal loss flow (never a row rewrite). */
async function reportLost(cardId: string): Promise<void> {
  const view = await banking.card.reportLostCard(cardId, DEMO_USER_ID, { reason: '卡遗失' });
  expect(view.status).toBe('LOST');
}

/** The number of `ACTIVE` cards of one type — a DELTA is asserted, never a whole-DB total. */
function activeOfType(rows: CardRowSnapshot[], type: string): number {
  return rows.filter((row) => row.type === type && row.status === 'ACTIVE').length;
}

describe('1. RED 补办 is reachable through the real gateway for every card type', () => {
  const scenarios: Array<{ label: string; arrange: () => Promise<string> }> = [
    { label: 'CREDIT', arrange: async () => { await reportLost('card_credit'); return 'card_credit'; } },
    { label: 'DEBIT', arrange: async () => { await reportLost('card_debit'); return 'card_debit'; } },
    {
      label: 'VIRTUAL',
      arrange: async () => {
        const card = await issueVirtualCard('500.00');
        await reportLost(card.id);
        return card.id;
      },
    },
  ];

  it.each(scenarios)(
    '$label: parks an MFA-gated decision with no effect, then mints exactly ONE ACTIVE replacement after verification',
    async ({ arrange }) => {
      const sourceId = await arrange();
      const before = await cardWorld();
      const sourceBefore = await cardRow(sourceId);
      expect(sourceBefore).toMatchObject({ status: 'LOST', replacedByCardId: null });

      // ── (a) The gateway parks the capability with a REAL MFA requirement and NO side effect. ──────
      const sessionId = await gatewaySession();
      const actionId = await parkReplace(sessionId, sourceId);
      await expectAwaitingMfa(actionId, sourceId);
      // Before the human decision the card world is byte-for-byte identical: no new card row, no
      // status change and no `replacedByCardId` link.
      expect(await cardWorld()).toEqual(before);

      // ── (b) The verified decision executes the ORIGINAL parked arguments. ─────────────────────────
      const outcome = await approve(sessionId, actionId);
      expect(outcome).toMatchObject({ ok: true, status: 'executed', tier: 'RED', requiresMfa: true });
      const replacement = await replacementOf(sourceId);
      const replacementView = outcome.result?.data as CardView;
      expect(replacementView.id).toBe(replacement.id);

      // Same owner, type, network and monthly limit; ACTIVE, freshly masked, and a VIRTUAL replacement
      // keeps the settlement binding it inherits from its predecessor (no other type carries one).
      expect(replacement).toMatchObject({
        type: sourceBefore.type,
        status: 'ACTIVE',
        replacedByCardId: null,
        linkedAccountId: sourceBefore.type === 'VIRTUAL' ? sourceBefore.linkedAccountId : null,
      });
      expect(replacement.monthlyLimitMinor).toBe(sourceBefore.monthlyLimitMinor);
      expect(await db().card.findUniqueOrThrow({ where: { id: replacement.id } })).toMatchObject({
        userId: DEMO_USER_ID,
      });
      expect(replacement.numberMasked).toMatch(/^\*{4}\d{4}$/);
      expect(replacement.numberMasked).not.toBe(sourceBefore.numberMasked);

      // ── Exactly ONE new card, and every pre-existing row is untouched except the source's link. ──
      const after = await cardWorld();
      expect(after).toHaveLength(before.length + 1);
      for (const previous of before) {
        const current = after.find((row) => row.id === previous.id);
        if (previous.id === sourceId) {
          // The source stays LOST with its own identity and only GAINS the historical link.
          expect(current).toEqual({ ...previous, replacedByCardId: replacement.id });
        } else {
          expect(current).toEqual(previous);
        }
      }
      expect(activeOfType(after, replacement.type)).toBe(activeOfType(before, replacement.type) + 1);
      const sourceAfter = await cardRow(sourceId);
      expect(sourceAfter).toMatchObject({ status: 'LOST', replacedByCardId: replacement.id });
      expect(sourceAfter.numberMasked).toBe(sourceBefore.numberMasked);
    },
  );

  it('CREDIT: inherits creditLimitMinor and availableLimitMinor UNCHANGED (no re-approval)', async () => {
    await reportLost('card_credit');
    const sourceBefore = await cardRow('card_credit');
    expect(sourceBefore).toMatchObject({ type: 'CREDIT', creditLimitMinor: moneyToCents('18000.00') });
    expect(sourceBefore.availableLimitMinor).toBe(moneyToCents('18000.00'));

    const sessionId = await gatewaySession();
    const actionId = await parkReplace(sessionId, 'card_credit');
    await expectAwaitingMfa(actionId, 'card_credit');
    const outcome = await approve(sessionId, actionId);
    expect(outcome).toMatchObject({ ok: true, status: 'executed' });

    const replacement = await replacementOf('card_credit');
    expect(replacement).toMatchObject({ type: 'CREDIT', status: 'ACTIVE' });
    expect(replacement.creditLimitMinor).toBe(sourceBefore.creditLimitMinor);
    expect(replacement.availableLimitMinor).toBe(sourceBefore.availableLimitMinor);
    // The returned projection reports the SAME exact canonical decimals.
    const view = outcome.result?.data as CardView;
    expect(view.creditLimit).toBe('18000.00');
    expect(view.availableLimit).toBe('18000.00');
    expect(view.status).toBe('ACTIVE');
    // The predecessor keeps its own limits; per-category limits are never copied to the replacement.
    expect((await cardRow('card_credit')).creditLimitMinor).toBe(sourceBefore.creditLimitMinor);
    expect(await db().cardLimit.count({ where: { cardId: replacement.id } })).toBe(0);
  });

  it('VIRTUAL: inherits the settlement binding AND keeps the current-month allowance continuous', async () => {
    const source = await issueVirtualCard('500.00');
    expect(source).toMatchObject({ type: 'VIRTUAL', status: 'ACTIVE', linkedAccountId: CHECKING });
    const cashBefore = (await db().account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor;
    expect(cashBefore).toBe(moneyToCents('23580.00'));

    // A spend booked on the SOURCE before 补办. It stays attributed to the card that incurred it, yet
    // it consumes the SAME monthly allowance the replacement continues (`cardFamilyMonthSpend`).
    const spend = await banking.card.consumeCard({
      userId: DEMO_USER_ID, cardId: source.id, amount: '120.00', merchant: '补办前消费',
    });
    expect(spend.consumption).toMatchObject({ cardId: source.id, accountId: CHECKING, amount: '120.00' });
    // Booked in the CURRENT UTC+08:00 business month, so it belongs to this month's allowance.
    expect(spend.consumption.occurredAt).toBe(demoNow());
    expect(spend.card.payableAmount).toBe('380.00');
    expect(await db().account.findUniqueOrThrow({ where: { id: CHECKING } }))
      .toMatchObject({ balanceMinor: cashBefore - moneyToCents('120.00') });

    await reportLost(source.id);
    const sessionId = await gatewaySession();
    const actionId = await parkReplace(sessionId, source.id);
    await expectAwaitingMfa(actionId, source.id);
    const outcome = await approve(sessionId, actionId);
    expect(outcome).toMatchObject({ ok: true, status: 'executed' });

    const replacement = await replacementOf(source.id);
    expect(replacement).toMatchObject({
      type: 'VIRTUAL', status: 'ACTIVE', linkedAccountId: CHECKING, replacedByCardId: null,
    });
    expect(replacement.monthlyLimitMinor).toBe(moneyToCents('500.00'));
    // 补办 books nothing: the booked spend was NOT rewritten or re-attributed.
    const rows = await db().cardConsumption.findMany({
      where: { userId: DEMO_USER_ID }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].cardId).toBe(source.id);
    expect(rows[0].amountMinor).toBe(moneyToCents('120.00'));

    // CONTINUITY, straight from the family walk: the replacement's family already spent ¥120 this month.
    expect(await cardFamilyMonthSpend(db(), replacement.id, DEMO_USER_ID)).toBe(moneyToCents('120.00'));
    // … and the enforced/displayed number agrees: min(¥23,460.00 cash, ¥500.00 − ¥120.00).
    const reported = outcome.result?.data as CardView;
    expect(reported).toMatchObject({ linkedAccountId: CHECKING, linkedAccountNumber: CHECKING_NUMBER });
    expect(reported.payableAmount).toBe('380.00');
    const view = (await banking.card.getCards(DEMO_USER_ID)).find((card) => card.id === replacement.id);
    expect(view?.payableAmount).toBe('380.00');
    // No second debit: the 补办 itself moved no money.
    expect(await db().account.findUniqueOrThrow({ where: { id: CHECKING } }))
      .toMatchObject({ balanceMinor: cashBefore - moneyToCents('120.00') });
  });
});

describe('2. a card that is NOT LOST is refused and is never reported lost first', () => {
  const scenarios: Array<{ label: string; arrange: () => Promise<string> }> = [
    { label: 'ACTIVE CREDIT', arrange: async () => 'card_credit' },
    {
      label: 'FROZEN DEBIT',
      arrange: async () => {
        const frozen = await banking.card.freezeCard('card_debit', DEMO_USER_ID);
        expect(frozen.status).toBe('FROZEN');
        return 'card_debit';
      },
    },
    { label: 'ACTIVE VIRTUAL', arrange: async () => (await issueVirtualCard('300.00')).id },
  ];

  it.each(scenarios)(
    '$label: the server refuses with CONFLICT and leaves the persisted row exactly as it was',
    async ({ arrange }) => {
      const sourceId = await arrange();
      const before = await cardWorld();
      const sourceBefore = await cardRow(sourceId);
      expect(sourceBefore.replacedByCardId).toBeNull();
      expect(sourceBefore.status).not.toBe('LOST');

      // The gateway parks a RED decision — the precondition is a COMMAND-time check in the SDK, so the
      // human decision is what reaches it. Nothing is minted before that decision either.
      const sessionId = await gatewaySession();
      const actionId = await parkReplace(sessionId, sourceId);
      await expectAwaitingMfa(actionId, sourceId);
      expect(await cardWorld()).toEqual(before);

      // ── The refusal itself. ───────────────────────────────────────────────────────────────────────
      const outcome = await approve(sessionId, actionId);
      expect(outcome.ok).toBe(false);
      expect(outcome.status).toBe('failed');
      expect(outcome.result).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
      expect(outcome.result?.error).toContain('只有已挂失的卡片可以补办，请先办理挂失。');

      // No EXECUTED decision, and no successful execution audit.
      const settled = await db().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
      expect(settled.status).toBe('failed');
      expect(await db().pendingAction.count({ where: { status: 'executed' } })).toBe(0);
      expect(await db().auditLog.count({ where: { dedupeKey: `exec:${actionId}`, status: 'success' } })).toBe(0);

      // ── The PERSISTED row is the assertion that matters: never flipped to LOST, never linked. ────
      const sourceAfter = await cardRow(sourceId);
      expect(sourceAfter.status).toBe(sourceBefore.status);
      expect(sourceAfter.replacedByCardId).toBeNull();
      expect(sourceAfter.numberMasked).toBe(sourceBefore.numberMasked);
      // Zero new cards: the whole world is identical to the arrange-time fingerprint.
      expect(await cardWorld()).toEqual(before);
    },
  );
});

describe('3. a duplicate 补办 request resolves to the SAME replacement card', () => {
  it('parks nothing for either request and both decisions land on ONE card', async () => {
    await reportLost('card_credit');
    const before = await cardWorld();
    const sessionId = await gatewaySession();

    const first = await parkReplace(sessionId, 'card_credit');
    const second = await parkReplace(sessionId, 'card_credit');
    // Two independent decisions over the same request (the park path reuses an action only for a
    // PLAN node) — but neither has executed anything, and neither demanded more than one code.
    expect(second).not.toBe(first);
    await expectAwaitingMfa(first, 'card_credit');
    await expectAwaitingMfa(second, 'card_credit');
    expect(await db().mfaChallenge.count({ where: { actionId: first } })).toBe(1);
    expect(await db().mfaChallenge.count({ where: { actionId: second } })).toBe(1);
    expect(await cardWorld()).toEqual(before);

    // First decision: the ONE replacement.
    const approved = await approve(sessionId, first);
    expect(approved).toMatchObject({ ok: true, status: 'executed' });
    const replacement = await replacementOf('card_credit');
    const worldAfterFirst = await cardWorld();
    expect(worldAfterFirst).toHaveLength(before.length + 1);

    // Second decision refers to the SAME replacement: no second card, no new mask, no new link.
    const again = await approve(sessionId, second);
    expect(again).toMatchObject({ ok: true, status: 'executed' });
    expect((again.result?.data as CardView).id).toBe(replacement.id);
    expect(await cardWorld()).toEqual(worldAfterFirst);
    expect((await cardRow('card_credit')).replacedByCardId).toBe(replacement.id);
  });

  it('replays the committed response for the SAME execution key without touching the write fence', async () => {
    await reportLost('card_credit');
    const sessionId = await gatewaySession();
    const actionId = await parkReplace(sessionId, 'card_credit');
    const outcome = await approve(sessionId, actionId);
    expect(outcome).toMatchObject({ ok: true, status: 'executed' });
    const replacement = await replacementOf('card_credit');
    const worldAfter = await cardWorld();

    const receipt = await db().executionReceipt.findUniqueOrThrow({
      where: { userId_key: { userId: DEMO_USER_ID, key: actionId } },
    });
    expect(receipt.toolName).toBe('replace_card');
    expect(JSON.parse(receipt.responseJson!)).toEqual(outcome.result);

    // The server-owned execution key is the action id; replaying it returns the ORIGINAL response and
    // never re-enters the write boundary (the fence would throw if it were entered).
    const fence = vi.fn(async () => {
      throw new Error('a replay of a committed 补办 must not enter the write fence');
    });
    const replay = await createToolRegistry(DEMO_USER_ID)
      .executeDirect('replace_card', { cardId: 'card_credit' }, { sessionId, idempotencyKey: actionId, fence });
    expect(replay).toEqual(outcome.result);
    expect((replay.data as CardView).id).toBe(replacement.id);
    expect(fence).not.toHaveBeenCalled();
    expect(await cardWorld()).toEqual(worldAfter);
    expect(await db().executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
  });
});
