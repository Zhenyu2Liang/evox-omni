/**
 * Scenario Test 3 — "给张伟转5000元" (RED transfer requires MFA, code 123456).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → RED MFA → Banking SDK → audit.
 *
 * The point of the scenario: a ¥5000 transfer crosses the >¥1000 daily/per-transfer threshold, so
 * the gateway classifies it 🔴 RED, BLOCKS the model's call in `beforeToolCall`, and persists a
 * `PendingAction` that only a HUMAN MFA verification against `MFA_CODE` can turn into money movement.
 * The model text can never do it.
 *
 * Only the MODEL is scripted (`buildFauxAgent`); the tools, the security chokepoint and the DB are
 * the real production ones. Everything is offline + deterministic (fresh seeded DB, unique sessionId).
 *
 * Fixtures: demo user 李明; contacts 张伟/王芳/妈妈/李华; 活期账户 ¥23,580.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import type { Transaction } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { security } from '@/security';
import { DAILY_TRANSFER_LIMIT, MFA_CODE } from '@/lib/constants';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '../helpers/fixtures';
import { buildFauxAgent, tool } from '../helpers/faux-agent';
import {
  cardsOfType,
  confirmAction,
  newSessionId,
  runTurn,
  toolEventsOf,
  verifyAction,
} from '../helpers/scenario';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '../helpers/db';

/** The 张伟 contact and the primary 活期 account from the canonical seed. */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
const CHECKING = ACCOUNTS.find((account) => account.type === 'CHECKING')!;

/** The exact RED transfer: ¥5000 to 张伟 (> the ¥1000 threshold). */
const TRANSFER_ARGS: { contactId: string; amount: string } = {
  contactId: ZHANGWEI.id,
  amount: '5000',
};
const USER_REQUEST = '给张伟转5000元';

/** Every row the flow can write for 张伟 — the canonical seed only has a 妈妈 transfer. */
function zhangweiTransfers(): Promise<Transaction[]> {
  return getTestPrisma().transaction.findMany({
    where: { accountId: CHECKING.id, counterpartyId: ZHANGWEI.id },
    orderBy: { occurredAt: 'desc' },
  });
}

/** The live 活期账户 balance. */
async function checkingBalance(): Promise<bigint> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return account.balanceMinor;
}
import { moneyToCents } from '@/lib/money';

/** Drive a fresh turn whose single model step proposes the RED transfer (blocked by the gateway). */
async function proposeRedTransfer() {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('transfer_money', TRANSFER_ARGS)],
  });
  const result = await runTurn({ sessionId, message: USER_REQUEST, agent });
  return { sessionId, agent, result };
}

beforeEach(async () => {
  await resetDatabase();
}, 30000);
afterAll(async () => {
  await disconnectTestPrisma();
});

describe('Scenario 3 — 给张伟转5000元 (RED MFA)', () => {
  it('transfer_money of ¥5000 exceeds the >1000 threshold and is classified RED by the policy table', async () => {
    const sessionId = newSessionId();

    // The gateway's own evaluation (static policy + dynamic amount rule) — never the model's.
    const evaluation = await security.gateway.securityGateway.evaluate({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: 'transfer_money',
      args: TRANSFER_ARGS,
      userRequest: USER_REQUEST,
    });

    expect(moneyToCents(TRANSFER_ARGS.amount)).toBeGreaterThan(moneyToCents(DAILY_TRANSFER_LIMIT));
    expect(evaluation.tier).toBe('RED');
    expect(evaluation.requiresConfirmation).toBe(true);
    expect(evaluation.requiresMfa).toBe(true);
    expect(evaluation.blocked).toBe(true);
  });

  it('the turn is BLOCKED by beforeToolCall and an mfa_required event / MFA card is surfaced', async () => {
    const { result } = await proposeRedTransfer();

    // RED ends the turn awaiting MFA — not a plain (YELLOW) confirmation.
    expect(result.mfa).toBeDefined();
    expect(result.mfa?.actionId).toBeTruthy();
    expect(result.confirmation).toBeUndefined();

    expect(result.events.some((event) => event.type === 'mfa_required')).toBe(true);
    expect(cardsOfType(result, 'mfa').length).toBeGreaterThan(0);

    // The transfer tool itself never ran: its only lifecycle event is `blocked`.
    const transferEvents = toolEventsOf(result, 'transfer_money');
    expect(transferEvents.length).toBeGreaterThan(0);
    expect(transferEvents.every((event) => event.status === 'blocked')).toBe(true);
  });

  it('a PendingAction is persisted (awaiting MFA) and NO Transaction row is written yet', async () => {
    const { sessionId, result } = await proposeRedTransfer();
    const actionId = result.mfa!.actionId;

    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(row.sessionId).toBe(sessionId);
    expect(row.toolName).toBe('transfer_money');
    expect(row.riskLevel).toBe('RED');
    expect(row.requiresMfa).toBe(true);
    // A RED action parks as `awaiting_mfa` (the gateway sets that status for MFA-gated calls).
    expect(row.status).toBe('awaiting_mfa');
    // The ORIGINAL validated args are what the gateway persisted (executed later, never model text).
    expect(JSON.parse(row.argsJson)).toMatchObject({ ...TRANSFER_ARGS, amount: '5000.00' });

    // No money has moved while the action waits for the human decision.
    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await checkingBalance()).toBe(moneyToCents(CHECKING.balance));
  });

  it('confirm without an MFA code does NOT execute the transfer (still awaiting MFA / no Transaction)', async () => {
    const { agent, result } = await proposeRedTransfer();
    const actionId = result.mfa!.actionId;

    const decide = await confirmAction(agent, actionId);

    // RED without a code ⇒ the gateway returns `awaiting_mfa` (ok:false) and runs nothing.
    expect(decide.text).toContain('验证码');
    expect(decide.mfa).toBeUndefined();

    expect(await zhangweiTransfers()).toHaveLength(0);
    expect(await checkingBalance()).toBe(moneyToCents(CHECKING.balance));

    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(row.status).toBe('awaiting_mfa');
  });

  it('verifyAction(actionId, "123456") executes the transfer successfully', async () => {
    const { agent, result } = await proposeRedTransfer();
    const actionId = result.mfa!.actionId;

    const decide = await verifyAction(agent, actionId, MFA_CODE);

    const transfers = await zhangweiTransfers();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].direction).toBe('DEBIT');
    expect(transfers[0].amountMinor).toBe(-500_000n);
    expect(transfers[0].category).toBe('转账');
    expect(transfers[0].channel).toBe('TRANSFER');
    expect(transfers[0].counterpartyId).toBe(ZHANGWEI.id);

    // 23,580 → 18,580.
    expect(await checkingBalance()).toBe(moneyToCents(CHECKING.balance) - 500_000n);

    const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(row.status).toBe('confirmed');

    expect(decide.text).toContain('张伟');
  });

  it('the audit row records mfaRequired true and mfaResult success (riskLevel RED)', async () => {
    const { sessionId, agent, result } = await proposeRedTransfer();
    const actionId = result.mfa!.actionId;

    await verifyAction(agent, actionId, MFA_CODE);

    const rows = await getTestPrisma().auditLog.findMany({
      where: { sessionId, toolName: 'transfer_money', status: 'success' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const auditRow = rows[0];
    expect(auditRow.riskLevel).toBe('RED');
    expect(auditRow.mfaRequired).toBe(true);
    expect(auditRow.mfaResult).toBe('success');
    expect(auditRow.status).toBe('success');
    expect(auditRow.confirmed).toBe(true);
    expect(auditRow.confirmationRequired).toBe(true);
  });

  it('the agent narration reports the factual 张伟 / ¥5000 executed outcome', async () => {
    const { agent, result } = await proposeRedTransfer();
    const actionId = result.mfa!.actionId;

    const decide = await verifyAction(agent, actionId, MFA_CODE);

    // The narration is driven by the REAL tool result (`已向 张伟 转账 ¥5,000.00，账户余额 ¥18,580.00。`).
    expect(decide.text).toContain('张伟');
    expect(decide.text).toMatch(/5,000|5000/);
    expect(decide.text).toContain('18,580');
  });
});
