/**
 * Scenario 13 — "我的借记卡丢了，帮我补办一张新卡" (RED replace_card requires MFA, code 123456).
 *
 * Pipeline: user message → Pi Agent (faux script) → `replace_card` → Security Gateway
 * (`beforeToolCall`) → RED MFA → Banking SDK → audit.
 *
 * Feature 3 requires that replacement is only possible for a card that is ALREADY lost, so the spec
 * seeds the LOST precondition through the REAL SDK (`banking.card.reportLostCard`) and then proves the
 * full RED flow: the model's call is blocked, a PendingAction parks as `awaiting_mfa`, NO card is
 * minted until the human supplies the code, and a successful MFA issues a NEW linked card while the
 * source stays LOST.
 *
 * Fixtures: demo user 李明; `card_debit` (DEBIT, UnionPay, ACTIVE, settlement account `acct_checking`).
 * The replacement INHERITS that settlement account, so the 补办 card spends from the same 活期 account.
 * Helpers: ../helpers/*.
 */
import { describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import { MFA_CODE } from '@/lib/constants';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { buildFauxAgent, tool } from '../helpers/faux-agent';
import {
  cancelAction,
  cardsOfType,
  newSessionId,
  runTurn,
  toolEventsOf,
  verifyAction,
} from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();

/** The DEBIT card the scenario replaces (must first become LOST). */
const CARD = 'card_debit';
const USER_REQUEST = '我的借记卡丢了，帮我补办一张新卡';
/**
 * The settlement CHECKING account the seeded DEBIT card spends from (see `CARDS` in
 * ../helpers/fixtures): 活期账户 ****8821, ¥23,580.00. A DEBIT card owns no balance of its own — this
 * account's cash is what it pays with, and 补办 must keep spending from the SAME account.
 */
const SETTLEMENT = 'acct_checking';
const SETTLEMENT_MASKED = '****8821';
const SETTLEMENT_BALANCE = '23580.00';

/** Seed the LOST precondition through the real SDK (replacement is only allowed from LOST). */
async function markLost(): Promise<void> {
  const lost = await banking.card.reportLostCard(CARD, DEMO_USER_ID, { reason: '遗失' });
  expect(lost.status).toBe('LOST');
}

/** Drive a fresh turn whose single model step proposes the RED `replace_card` call. */
async function proposeReplace(): Promise<{
  sessionId: string;
  agent: ReturnType<typeof buildFauxAgent>;
  res: Awaited<ReturnType<typeof runTurn>>;
}> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('replace_card', { cardId: CARD })],
  });
  const res = await runTurn({ sessionId, message: USER_REQUEST, agent });
  return { sessionId, agent, res };
}

/** All cards owned by the demo user (the replacement is a brand-new row). */
function userCards() {
  return getTestPrisma().card.findMany({ where: { userId: DEMO_USER_ID } });
}

describe('Scenario 13 — 补办挂失卡片 (RED MFA replace_card)', () => {
  it('replace_card is classified RED and the model call is BLOCKED (never executed inline)', async () => {
    await markLost();
    const { res } = await proposeReplace();

    // RED ends the turn awaiting MFA — not a plain (YELLOW) confirmation.
    expect(res.mfa).toBeDefined();
    expect(res.mfa?.actionId).toBeTruthy();
    expect(res.confirmation).toBeUndefined();
    expect(res.events.some((event) => event.type === 'mfa_required')).toBe(true);
    expect(cardsOfType(res, 'mfa').length).toBeGreaterThan(0);

    const events = toolEventsOf(res, 'replace_card');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.status === 'blocked')).toBe(true);
  });

  it('parks a RED awaiting_mfa PendingAction and mints NO card before MFA', async () => {
    await markLost();
    const before = await userCards();
    const { sessionId, res } = await proposeReplace();
    const actionId = res.mfa!.actionId;

    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(row.sessionId).toBe(sessionId);
    expect(row.toolName).toBe('replace_card');
    expect(row.riskLevel).toBe('RED');
    expect(row.requiresMfa).toBe(true);
    expect(row.status).toBe('awaiting_mfa');
    // The gateway persisted the ORIGINAL validated args (executed later, never model text).
    expect(JSON.parse(row.argsJson)).toEqual({ cardId: CARD });

    // Nothing was written while the action waits for the human decision.
    expect(await userCards()).toHaveLength(before.length);
    expect((await getTestPrisma().card.findUniqueOrThrow({ where: { id: CARD } })).replacedByCardId).toBeNull();
  });

  it('verifyAction(123456) mints a NEW card and links the LOST source', async () => {
    await markLost();
    const { agent, res } = await proposeReplace();
    const before = await userCards();

    const decide = await verifyAction(agent, res.mfa!.actionId, MFA_CODE);

    const after = await userCards();
    expect(after).toHaveLength(before.length + 1);

    // The source stays LOST and points at exactly one replacement.
    const source = await getTestPrisma().card.findUniqueOrThrow({ where: { id: CARD } });
    expect(source.status).toBe('LOST');
    expect(source.replacedByCardId).not.toBeNull();
    // A DEBIT card is ACCOUNT-BOUND: the seeded one records the 活期 checking account.
    expect(source.linkedAccountId).toBe(SETTLEMENT);

    // The replacement is a fresh ACTIVE card: same owner, same type + network, fresh masked number.
    const replacement = await getTestPrisma().card.findUniqueOrThrow({ where: { id: source.replacedByCardId! } });
    expect(replacement.userId).toBe(DEMO_USER_ID);
    expect(replacement.type).toBe('DEBIT');
    expect(replacement.network).toBe('UnionPay');
    expect(replacement.status).toBe('ACTIVE');
    expect(replacement.numberMasked).toMatch(/^\*{4}\d{4}$/);
    expect(replacement.numberMasked).not.toBe(source.numberMasked);
    // 补办 INHERITS the settlement account and never guesses one: the new card spends from the SAME
    // 活期 account (an unbound replacement would project as MISSING and be unable to pay at all).
    expect(replacement.linkedAccountId).toBe(SETTLEMENT);

    // The projection resolves that binding: LINKED with the ACCOUNT's masked number and cash. A DEBIT
    // card owns no balance of its own and sets no monthly limit here, so all the account cash is payable.
    const view = (await banking.card.getCards(DEMO_USER_ID)).find((entry) => entry.id === replacement.id);
    expect(view).toBeDefined();
    expect(view!.linkedAccountId).toBe(SETTLEMENT);
    expect(view!.linkedAccountStatus).toBe('LINKED');
    expect(view!.linkedAccountNumber).toBe(SETTLEMENT_MASKED);
    expect(view!.accountAvailableBalance).toBe(SETTLEMENT_BALANCE);
    expect(view!.payableAmount).toBe(SETTLEMENT_BALANCE);
    expect(view!.usable).toBe(true);

    expect(
      (await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: res.mfa!.actionId } })).status,
    ).toBe('confirmed');
    expect(decide.text).toContain('补办');
  });

  it('records a RED audit row with mfaRequired true and mfaResult success', async () => {
    await markLost();
    const { sessionId, agent, res } = await proposeReplace();

    await verifyAction(agent, res.mfa!.actionId, MFA_CODE);

    const rows = await getTestPrisma().auditLog.findMany({
      where: { sessionId, toolName: 'replace_card', status: 'success' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const audit = rows[0];
    expect(audit.riskLevel).toBe('RED');
    expect(audit.mfaRequired).toBe(true);
    expect(audit.mfaResult).toBe('success');
    expect(audit.confirmed).toBe(true);
  });

  it('cancel leaves the source LOST and mints no replacement', async () => {
    await markLost();
    const before = await userCards();
    const { agent, res } = await proposeReplace();

    await cancelAction(agent, res.mfa!.actionId);

    expect(await userCards()).toHaveLength(before.length);
    const source = await getTestPrisma().card.findUniqueOrThrow({ where: { id: CARD } });
    expect(source.status).toBe('LOST');
    expect(source.replacedByCardId).toBeNull();
  });
});
