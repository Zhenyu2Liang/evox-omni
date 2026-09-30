/**
 * Scenario Test 2 — "给张伟转200元，备注AA" (YELLOW transfer requires confirmation).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → YELLOW confirm → Banking SDK → audit.
 *
 * Only the MODEL is scripted (`buildFauxAgent`); the banking tools, the security chokepoint
 * (`beforeToolCall` → `security-gateway`) and the SQLite DB are the real ones. The two-phase
 * flow is proven end-to-end: the model's `transfer_money` call is BLOCKED (a `PendingAction`
 * is parked, NO money moves), and only the human `confirm(actionId)` executes the ORIGINAL
 * validated args through the SDK before the agent narrates the factual outcome.
 *
 * Fixtures: demo user 李明; recipient 张伟 (contact `contact_zhangwei`); funding account
 * 活期账户 `acct_checking` @ ¥23,580.
 *
 * NOTE on the recipient arg: `buildPendingActionSummary` renders the 收款人 field from the
 * args' name-ish keys — `contactId` is deliberately NOT resolved for display. The model
 * therefore addresses 张伟 by NAME so the confirmation summary/card shows 收款人 张伟 (the
 * demo's acceptance bar). The transfer still resolves to the seeded contact, which is proven
 * by asserting the written transaction's `counterpartyId === contact_zhangwei`.
 *
 * Helpers: ../helpers (faux-agent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import { cardsOfType, confirmAction, newSessionId, runTurn, toolEventsOf } from '../helpers/scenario';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '../helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '../helpers/fixtures';
import { RISK_LABEL } from '@/lib/constants';
import { formatCNY } from '@/lib/money';
import type { PendingActionSummary } from '@/lib/contracts/security';

beforeEach(async () => {
  await resetDatabase();
}, 30000);
afterAll(async () => {
  await disconnectTestPrisma();
});

/** Funding account 活期账户 (¥23,580) — the default transfer source. */
const CHECKING = ACCOUNTS[0];
/** Recipient 张伟 / `contact_zhangwei`. */
const ZHANGWEI = CONTACTS[0];

const AMOUNT = 200;
const REMARK = 'AA';
const USER_MESSAGE = '给张伟转200元，备注AA';

/** The exact args the scripted model proposes for `transfer_money`. */
const TRANSFER_ARGS = { name: ZHANGWEI.name, amount: AMOUNT, remark: REMARK };

/** The model's ONE tool call, followed by a first-turn narration (so the script never runs dry). */
const SCRIPT = [tool('transfer_money', TRANSFER_ARGS), final('转账已提交，等待你确认后执行。')];

/** Send the demo message; the YELLOW `transfer_money` call is gated → a `PendingAction` is parked. */
async function startPendingTransfer(sessionId = newSessionId()) {
  const agent = buildFauxAgent({ sessionId, script: [...SCRIPT] });
  const pending = await runTurn({ sessionId, message: USER_MESSAGE, agent });
  return { sessionId, agent, pending };
}

/** Run the full two-phase flow and return the human-decision continuation result. */
async function runConfirmedTransfer() {
  const { sessionId, agent, pending } = await startPendingTransfer();
  const actionId = pending.confirmation?.actionId;
  if (actionId === undefined) throw new Error('expected a pending confirmation, got none');
  const after = await confirmAction(agent, actionId);
  return { sessionId, pending, after };
}

/** Read one labelled field value out of a `PendingActionSummary`. */
function fieldValue(summary: PendingActionSummary, label: string): string | undefined {
  return summary.fields.find((field) => field.label === label)?.value;
}

describe('Scenario 2 — 给张伟转200元 (YELLOW confirm)', () => {
  it('transfer_money of ¥200 is classified YELLOW and BLOCKED by beforeToolCall', async () => {
    const { pending } = await startPendingTransfer();

    // The gateway blocked the call and parked it for a human decision.
    expect(pending.confirmation).toBeDefined();
    expect(pending.confirmation?.action.toolName).toBe('transfer_money');
    expect(pending.confirmation?.action.tier).toBe('YELLOW');
    expect(pending.confirmation?.action.requiresMfa).toBe(false);

    // YELLOW → confirmation only, never MFA.
    expect(pending.mfa).toBeUndefined();

    // The tool itself never executed: its timeline entry ends as `blocked`, no success anywhere.
    const transferEvents = toolEventsOf(pending, 'transfer_money');
    expect(transferEvents.length).toBeGreaterThan(0);
    expect(transferEvents[transferEvents.length - 1].status).toBe('blocked');
    expect(pending.toolEvents.some((event) => event.status === 'success')).toBe(false);
  });

  it('a PendingAction is persisted with status pending and summary 收款人 张伟 / 金额 ¥200.00', async () => {
    const { sessionId, pending } = await startPendingTransfer();

    const rows = await getTestPrisma().pendingAction.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    const row = rows[0];

    expect(row.toolName).toBe('transfer_money');
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.requiresMfa).toBe(false);
    expect(row.status).toBe('pending');
    expect(JSON.parse(row.argsJson)).toMatchObject(TRANSFER_ARGS);

    // `summaryJson` is the exact `PendingActionSummary` the gateway persists for the caller.
    const summary = JSON.parse(row.summaryJson) as PendingActionSummary;
    expect(summary.tier).toBe('YELLOW');
    expect(fieldValue(summary, '收款人')).toBe(ZHANGWEI.name);
    expect(fieldValue(summary, '金额')).toBe(formatCNY(AMOUNT));

    // `res.confirmation.action` is loaded back from the persisted row → identical fields.
    expect(pending.confirmation?.action).toEqual(summary);
    expect(pending.confirmation?.action.fields).toEqual([
      { label: '收款人', value: ZHANGWEI.name },
      { label: '金额', value: formatCNY(AMOUNT) },
      { label: '账户', value: '默认活期账户' },
      { label: '风险等级', value: RISK_LABEL.YELLOW },
    ]);
  });

  it('a confirmation_required event and a confirmation card are surfaced', async () => {
    const { pending } = await startPendingTransfer();

    const confirmationEvents = pending.events.filter(
      (event) => event.type === 'confirmation_required',
    );
    expect(confirmationEvents).toHaveLength(1);
    const [confirmationEvent] = confirmationEvents;
    if (confirmationEvent.type !== 'confirmation_required') {
      throw new Error('expected a confirmation_required event');
    }
    expect(confirmationEvent.actionId).toBe(pending.confirmation?.actionId);
    expect(confirmationEvent.action.tier).toBe('YELLOW');

    const cards = cardsOfType(pending, 'confirmation');
    expect(cards).toHaveLength(1);
    expect(cards[0].action.toolName).toBe('transfer_money');
    expect(fieldValue(cards[0].action, '收款人')).toBe(ZHANGWEI.name);
    expect(fieldValue(cards[0].action, '金额')).toBe(formatCNY(AMOUNT));
  });

  it('NO Transaction row and no balance change exist while the action is pending', async () => {
    const { sessionId, pending } = await startPendingTransfer();
    const prisma = getTestPrisma();

    // The call is parked, not executed — the action is still `pending`.
    expect(pending.confirmation?.actionId).toBeDefined();
    const rows = await prisma.pendingAction.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');

    // No transfer to 张伟 was written and the funding balance is untouched. (Scoped by
    // `counterpartyId` — the seed happens to contain an unrelated ¥200 娱乐 spend.)
    const transferDebits = await prisma.transaction.count({
      where: { accountId: CHECKING.id, counterpartyId: ZHANGWEI.id },
    });
    expect(transferDebits).toBe(0);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: CHECKING.id } });
    expect(account.balance).toBe(CHECKING.balance);
    expect(account.balance).toBe(23580);
  });

  it('confirm(actionId) executes the ORIGINAL validated args through the SDK authorized path', async () => {
    const { sessionId, after } = await runConfirmedTransfer();
    const prisma = getTestPrisma();

    // The human decision authorized the action (gateway flipped it to `confirmed`).
    const rows = await prisma.pendingAction.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('confirmed');

    // Execution used the ORIGINAL args the gateway validated/persisted — not model text.
    expect(JSON.parse(rows[0].argsJson)).toMatchObject({
      name: ZHANGWEI.name,
      amount: AMOUNT,
      remark: REMARK,
    });
    const executed = await prisma.transaction.findFirstOrThrow({
      where: { accountId: CHECKING.id, counterpartyId: ZHANGWEI.id, amount: -AMOUNT },
    });
    expect(executed.counterpartyId).toBe(ZHANGWEI.id);
    expect(executed.remark).toBe(REMARK);

    // The continuation ran cleanly (the narration is driven by the REAL tool result).
    expect(after.error).toBeUndefined();
  });

  it('after confirm: a DEBIT ¥200 Transaction is written and balance goes 23580 → 23380', async () => {
    const { after } = await runConfirmedTransfer();
    const prisma = getTestPrisma();

    // Scoped by `counterpartyId` — the seed happens to contain an unrelated ¥200 娱乐 spend.
    const debits = await prisma.transaction.findMany({
      where: { accountId: CHECKING.id, counterpartyId: ZHANGWEI.id, amount: -AMOUNT },
    });
    expect(debits).toHaveLength(1);
    expect(debits[0].direction).toBe('DEBIT');
    expect(debits[0].userId).toBe(DEMO_USER_ID);
    expect(debits[0].channel).toBe('TRANSFER');
    expect(debits[0].counterpartyId).toBe(ZHANGWEI.id);
    expect(debits[0].remark).toBe(REMARK);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: CHECKING.id } });
    expect(account.balance).toBe(CHECKING.balance - AMOUNT);
    expect(account.balance).toBe(23380);

    expect(after.error).toBeUndefined();
  });

  it('the audit row for the executed transfer has status success (riskLevel YELLOW)', async () => {
    const { sessionId } = await runConfirmedTransfer();

    const audit = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(audit).toHaveLength(1);
    const [row] = audit;
    expect(row.toolName).toBe('transfer_money');
    expect(row.riskLevel).toBe('YELLOW');
    expect(row.status).toBe('success');
    expect(row.confirmationRequired).toBe(true);
    expect(row.confirmed).toBe(true);
    expect(row.mfaRequired).toBe(false);
  });

  it('the agent narration states the factual 张伟 / ¥200 outcome (no hallucinated details)', async () => {
    const { after } = await runConfirmedTransfer();

    expect(after.error).toBeUndefined();
    expect(after.text).toContain(ZHANGWEI.name); // 张伟
    expect(after.text).toContain(formatCNY(AMOUNT)); // ¥200.00
    expect(after.text).toContain('200');
  });
});
