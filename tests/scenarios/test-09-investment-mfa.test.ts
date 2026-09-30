/**
 * Scenario Test 9 — "买5000元稳健理财A" (RED investment subscription requires MFA).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → RED MFA → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it().
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 *
 * Only the MODEL is scripted (`registerFauxProvider`, `LLM_MODE=mock`); the tools, the
 * security chokepoint (`beforeToolCall`) and the SQLite DB are the real ones. The point of
 * this spec: the model CANNOT move money past MFA — `subscribe_investment` is RED, the gateway
 * BLOCKS it, and nothing is executed until a HUMAN submits the code.
 */
import { describe, it, expect } from 'vitest';
import { buildFauxAgent, tool, final } from '../helpers/faux-agent';
import {
  runTurn,
  confirmAction,
  verifyAction,
  newSessionId,
  toolEventsOf,
  cardsOfType,
} from '../helpers/scenario';
import { useFreshDatabase, getTestPrisma } from '../helpers/db';
import { PRODUCTS, ACCOUNTS, DEMO_USER_ID } from '../helpers/fixtures';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { MFA_CODE } from '@/lib/constants';
import { security } from '@/security';

/** 稳健理财A — the RED subscription target (R2, min ¥1,000). */
const PRODUCT = PRODUCTS.find((product) => product.name === '稳健理财A') ?? PRODUCTS[0];
/** 活期账户 `acct_checking` — the funding account the subscription debits (seed ¥23,580). */
const CHECKING = ACCOUNTS.find((account) => account.id === 'acct_checking') ?? ACCOUNTS[0];

/** The subscription amount from the demo prompt "买5000元稳健理财A". */
const SUBSCRIBE_AMOUNT = 5000;
const USER_MESSAGE = '买5000元稳健理财A';

/**
 * The scripted model turn: propose the RED `subscribe_investment` call, then narrate that
 * the operation is high-risk and awaits verification (the tool is BLOCKED, so the model can
 * only report the gate — it can never claim success here).
 */
function redSubscriptionScript() {
  return [
    tool('subscribe_investment', { productId: PRODUCT.id, amount: SUBSCRIBE_AMOUNT }),
    final('该认购为高风险，请完成安全验证。'),
  ];
}

/** Drive one full turn of the scenario and return the agent + the collected result. */
async function driveTurn() {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({ sessionId, script: redSubscriptionScript() });
  const res = await runTurn({ sessionId, message: USER_MESSAGE, agent });
  return { sessionId, agent, res };
}

describe('Scenario 9 — 买5000元稳健理财A (RED MFA)', () => {
  useFreshDatabase();

  it('subscribe_investment is STATICALLY classified RED and BLOCKED by beforeToolCall', async () => {
    const sessionId = newSessionId();

    // The tier comes from the STATIC policy table in code — never from model text.
    const evaluation = security.permission.evaluateTool(
      'subscribe_investment',
      { productId: PRODUCT.id, amount: SUBSCRIBE_AMOUNT },
      { userId: DEMO_USER_ID, sessionId, dailyTransferTotal: 0 },
    );
    expect(evaluation.tier).toBe('RED');
    expect(evaluation.requiresMfa).toBe(true);
    expect(evaluation.requiresConfirmation).toBe(true);

    const agent = buildFauxAgent({ sessionId, script: redSubscriptionScript() });
    const res = await runTurn({ sessionId, message: USER_MESSAGE, agent });

    // The gateway blocked the call BEFORE execution — it never reached the Banking SDK.
    const events = toolEventsOf(res, 'subscribe_investment');
    expect(events.filter((event) => event.status === 'blocked')).toHaveLength(1);
    expect(events.some((event) => event.status === 'success')).toBe(false);

    // RED ⇒ an MFA challenge (never a plain YELLOW confirmation).
    expect(res.mfa).toBeDefined();
    expect(res.confirmation).toBeUndefined();
  });

  it('an mfa_required event / MFA card is surfaced and a PendingAction is persisted', async () => {
    const { sessionId, res } = await driveTurn();

    const actionId = res.mfa?.actionId ?? '';
    expect(actionId).not.toBe('');

    // Stream: exactly one `mfa_required` event carrying the action id.
    const mfaEvents = res.events.filter(
      (event): event is Extract<AgentStreamEvent, { type: 'mfa_required' }> =>
        event.type === 'mfa_required',
    );
    expect(mfaEvents).toHaveLength(1);
    expect(mfaEvents[0]?.actionId).toBe(actionId);

    // Stream: exactly one code-free MFA card.
    const mfaCards = cardsOfType(res, 'mfa');
    expect(mfaCards).toHaveLength(1);
    expect(mfaCards[0]?.actionId).toBe(actionId);
    expect(mfaCards[0]?.hint ?? '').not.toContain(MFA_CODE);
    expect(res.mfa?.hint ?? '').not.toContain(MFA_CODE);

    // DB: the ORIGINAL model args are persisted, RED + awaiting MFA.
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
    expect(row).not.toBeNull();
    expect(row?.sessionId).toBe(sessionId);
    expect(row?.toolName).toBe('subscribe_investment');
    expect(row?.riskLevel).toBe('RED');
    expect(row?.requiresMfa).toBe(true);
    expect(row?.status).toBe('awaiting_mfa');
    expect(JSON.parse(row?.argsJson ?? '{}')).toMatchObject({
      productId: PRODUCT.id,
      amount: SUBSCRIBE_AMOUNT,
    });
  });

  it('confirm without an MFA code does NOT execute the subscription', async () => {
    const { agent, res } = await driveTurn();
    const actionId = res.mfa?.actionId ?? '';
    expect(actionId).not.toBe('');

    const prisma = getTestPrisma();
    const holdingsBefore = await prisma.investmentHolding.count();
    const balanceBefore = (await prisma.account.findUnique({ where: { id: CHECKING.id } }))
      ?.balance;
    expect(balanceBefore).toBe(CHECKING.balance);

    const confirmRes = await confirmAction(agent, actionId);

    // The gateway answers "awaiting MFA" and runs NOTHING.
    expect(confirmRes.text).toContain('验证码');
    expect(confirmRes.toolEvents).toHaveLength(0);

    expect(await prisma.investmentHolding.count()).toBe(holdingsBefore);
    expect((await prisma.account.findUnique({ where: { id: CHECKING.id } }))?.balance).toBe(
      balanceBefore,
    );

    // Still parked — not confirmed, not executed.
    const row = await prisma.pendingAction.findUnique({ where: { id: actionId } });
    expect(row?.status).toBe('awaiting_mfa');
  });

  it('verifyAction(actionId, "123456") creates an InvestmentHolding of ¥5000 for 稳健理财A', async () => {
    const { agent, res } = await driveTurn();
    const actionId = res.mfa?.actionId ?? '';
    expect(actionId).not.toBe('');

    const prisma = getTestPrisma();
    const before = await prisma.investmentHolding.findMany();

    const verifyRes = await verifyAction(agent, actionId, MFA_CODE);
    expect(verifyRes.error).toBeUndefined();
    // The continuation narrates the FACTUAL tool result (its summary), never invented prose.
    expect(verifyRes.text).toContain('已认购');

    const after = await prisma.investmentHolding.findMany();
    expect(after).toHaveLength(before.length + 1);

    const created = after.find((holding) => !before.some((prev) => prev.id === holding.id));
    expect(created?.productId).toBe(PRODUCT.id);
    expect(created?.userId).toBe(DEMO_USER_ID);
    expect(created?.amount).toBe(SUBSCRIBE_AMOUNT);
    expect(created?.marketValue).toBe(SUBSCRIBE_AMOUNT);
    expect(created?.status).toBe('HOLDING');
  });

  it('the funding account (活期) is debited by ¥5000', async () => {
    const { agent, res } = await driveTurn();
    const actionId = res.mfa?.actionId ?? '';
    expect(actionId).not.toBe('');

    const prisma = getTestPrisma();
    const before = (await prisma.account.findUnique({ where: { id: CHECKING.id } }))?.balance;
    expect(before).toBe(CHECKING.balance);

    await verifyAction(agent, actionId, MFA_CODE);

    const after = (await prisma.account.findUnique({ where: { id: CHECKING.id } }))?.balance;
    expect(after).toBe(CHECKING.balance - SUBSCRIBE_AMOUNT);
    expect(after).toBe(18580);
  });

  it('the audit row records mfaRequired true and mfaResult success (riskLevel RED)', async () => {
    const { sessionId, agent, res } = await driveTurn();
    const actionId = res.mfa?.actionId ?? '';
    expect(actionId).not.toBe('');

    await verifyAction(agent, actionId, MFA_CODE);

    const rows = await getTestPrisma().auditLog.findMany({
      where: { sessionId, toolName: 'subscribe_investment' },
    });
    const executed = rows.find((row) => row.mfaResult === 'success');
    expect(executed).toBeDefined();
    expect(executed?.sessionId).toBe(sessionId);
    expect(executed?.riskLevel).toBe('RED');
    expect(executed?.mfaRequired).toBe(true);
    expect(executed?.mfaResult).toBe('success');
    expect(executed?.confirmed).toBe(true);
    expect(executed?.status).toBe('success');
  });
});
