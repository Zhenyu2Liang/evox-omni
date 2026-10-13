/**
 * Scenario Test 5 — transfer failure must be reported truthfully (no hallucinated success).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → YELLOW/RED decision → Banking SDK → audit.
 *
 * KEY FACT the assertions encode: `transfer_money` is ALWAYS gated (🟡 ≤¥1000 / 🔴 above), so the
 * model's proposal is BLOCKED by `beforeToolCall` during the turn — nothing executes inline and, by
 * consequence, NO SDK "error tool event" can ever surface during the turn (a gated call is
 * `blocked`, not `error`). The real failure surfaces AFTER the human decision: once the correct MFA
 * code authorizes the pending action, the gateway-authorized path runs the ORIGINAL validated args
 * through the Banking SDK, which rejects the transfer (INSUFFICIENT_FUNDS — ¥30,000 > the ¥23,580
 * balance), the audit row is written with status `failed`, and the continuation narrates that SAME
 * real error. The agent must report the failure truthfully and never a hallucinated success.
 *
 * Fixtures: demo user 李明; checking balance ¥23,580; contact 张伟.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildFauxAgent, callThen } from '../helpers/faux-agent';
import { newSessionId, runTurn, toolEventsOf, verifyAction, type ScenarioResult } from '../helpers/scenario';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '../helpers/db';
import { ACCOUNTS, CONTACTS } from '../helpers/fixtures';
import { MFA_CODE } from '@/lib/constants';
import { moneyToCents } from '@/lib/money';

beforeEach(async () => {
  await resetDatabase();
}, 30000);
afterAll(async () => {
  await disconnectTestPrisma();
});

/** The demo recipient 张伟 (seeded contact) and the primary checking account (¥23,580). */
const RECIPIENT = CONTACTS.find((c) => c.name === '张伟')!;
const CHECKING = ACCOUNTS.find((a) => a.type === 'CHECKING')!;

/** Far above both the ¥1,000 RED threshold and the ¥23,580 balance ⇒ RED + INSUFFICIENT_FUNDS. */
const TRANSFER_AMOUNT = '30000';
/**
 * Fragment of the SDK's insufficient-funds message. `runTransferMoney` catches the SDK's
 * `AppError('INSUFFICIENT_FUNDS')` and returns `{ ok:false, error: <message> }`, so the CODE is not
 * propagated — only this message is observable through the tool result / audit / narration.
 */
const INSUFFICIENT_FUNDS = /Insufficient funds/i;
/** Success phrasings a hallucinating agent might emit — none may appear when the audit says `failed`. */
const SUCCESS_PHRASING = /已向.*转账|转账成功|已成功转出/;

interface FailedTransferRun {
  sessionId: string;
  /** Turn 1 — the gated (BLOCKED) transfer, awaiting MFA. */
  turn: ScenarioResult;
  /** Turn 2 — the continuation after the human MFA decision executed the SDK call (which failed). */
  decision: ScenarioResult;
  /** Transaction row count BEFORE the decision, to prove the failure writes nothing. */
  txCountBefore: number;
}

/**
 * Drive the full Test-5 flow against a FRESH session: the model proposes a RED ¥30,000 transfer
 * (BLOCKED at gate time by the Security Gateway), then the human submits the correct MFA code so the
 * gateway-authorized path runs the ORIGINAL args through the Banking SDK (which rejects them).
 */
async function runFailedTransfer(): Promise<FailedTransferRun> {
  const prisma = getTestPrisma();
  const txCountBefore = await prisma.transaction.count();

  const sessionId = newSessionId('sess-test5');
  const agent = buildFauxAgent({
    sessionId,
    script: callThen('该笔转账金额较大，需通过安全验证后才能执行。', 'transfer_money', {
      contactId: RECIPIENT.id,
      amount: TRANSFER_AMOUNT,
    }),
  });

  const turn = await runTurn({
    sessionId,
    message: `给${RECIPIENT.name}转${TRANSFER_AMOUNT}元`,
    agent,
  });

  const actionId = turn.mfa?.actionId;
  if (actionId === undefined) {
    throw new Error(
      'Scenario 5 setup: expected the ¥30000 transfer to be RED and park for MFA (turn.mfa missing)',
    );
  }

  const decision = await verifyAction(agent, actionId, MFA_CODE);
  return { sessionId, turn, decision, txCountBefore };
}

describe('Scenario 5 — 转账失败如实上报 (INSUFFICIENT_FUNDS)', () => {
  it('the ¥30000 transfer is RED (>¥1000) and is BLOCKED by beforeToolCall during the turn — no success tool event, no SDK execution', async () => {
    const { turn } = await runFailedTransfer();

    // RED ⇒ the call parks for MFA and never executes inline.
    expect(turn.mfa, 'a RED transfer must surface an mfa_required decision').toBeDefined();
    expect(turn.confirmation, 'a RED transfer is not a plain YELLOW confirmation').toBeUndefined();

    const transferEvents = toolEventsOf(turn, 'transfer_money');
    expect(transferEvents.some((e) => e.status === 'blocked')).toBe(true);
    expect(transferEvents.some((e) => e.status === 'success')).toBe(false);
  });

  it('on the HUMAN MFA decision the ORIGINAL args run through the Banking SDK, which rejects the transfer (ok:false, insufficient funds)', async () => {
    const { sessionId, decision } = await runFailedTransfer();

    const row = await getTestPrisma().auditLog.findFirst({
      where: { sessionId, toolName: 'transfer_money' },
      orderBy: { timestamp: 'desc' },
    });
    expect(row).not.toBeNull();

    const stored = JSON.parse(row!.toolResult ?? 'null') as { ok?: boolean; error?: string } | null;
    expect(stored?.ok).toBe(false);
    expect(stored?.error ?? '').toMatch(INSUFFICIENT_FUNDS);

    // The continuation narrated the SAME real failure — not a fabricated one.
    expect(decision.text).toMatch(INSUFFICIENT_FUNDS);
  });

  it('the agent REPORTS FAILURE truthfully and does NOT hallucinate a successful transfer', async () => {
    const { sessionId, decision } = await runFailedTransfer();

    // The persisted outcome is a failure …
    const failedRows = await getTestPrisma().auditLog.count({
      where: { sessionId, toolName: 'transfer_money', status: 'failed' },
    });
    expect(failedRows).toBe(1);

    // … so the narration must carry the failure and must NOT claim success.
    expect(decision.text).toMatch(INSUFFICIENT_FUNDS);
    expect(decision.text).not.toMatch(SUCCESS_PHRASING);
    expect(toolEventsOf(decision, 'transfer_money').some((e) => e.status === 'success')).toBe(false);
  });

  it('the audit row for the failed transfer has status failed (riskLevel RED, mfaRequired true, mfaResult success)', async () => {
    const { sessionId } = await runFailedTransfer();

    const rows = await getTestPrisma().auditLog.findMany({
      where: { sessionId, toolName: 'transfer_money' },
    });
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.status).toBe('failed');
    expect(row.riskLevel).toBe('RED');
    expect(row.mfaRequired).toBe(true);
    expect(row.mfaResult).toBe('success');
    expect(row.confirmed).toBe(true);
  });

  it('no Transaction is written and the checking balance stays ¥23580 after the failed decision', async () => {
    const { txCountBefore } = await runFailedTransfer();
    const prisma = getTestPrisma();

    // The funding account is untouched (a transfer would debit it).
    expect(CHECKING.balance).toBe('23580.00');
    const account = await prisma.account.findUnique({ where: { id: CHECKING.id } });
    expect(account?.balanceMinor).toBe(moneyToCents(CHECKING.balance));

    // No new ledger row at all, and specifically nothing to 张伟.
    expect(await prisma.transaction.count()).toBe(txCountBefore);
    expect(await prisma.transaction.count({ where: { counterpartyId: RECIPIENT.id } })).toBe(0);
  });
});
