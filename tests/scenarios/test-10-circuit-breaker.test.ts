/**
 * Scenario Test 10 — 3 consecutive wrong MFA codes trip the circuit breaker (session lock).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → RED MFA (wrong code x3) → circuit breaker trips → SecurityEvent + audit.
 *
 * Only the MODEL is scripted; the tools, the Security Gateway `beforeToolCall` chokepoint and the
 * SecurityEvent rows are the real ones. The breaker state is in-process keyed by `sessionId`, so
 * every test mints a UNIQUE `newSessionId()` (a lock must never leak into another spec).
 *
 * Asserted outcome (see the `it` list): the failure counter increments 1→2→3, the breaker trips and
 * locks the session, a `CIRCUIT_BREAKER_TRIPPED` / severity `high` SecurityEvent is persisted, and a
 * subsequent RED attempt (even with the CORRECT demo code) is refused with status `locked` while
 * nothing executes (no new holding, balance untouched).
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '@mariozechner/pi-agent-core';
import { buildFauxAgent, tool, final } from '../helpers/faux-agent';
import { runTurn, verifyAction, newSessionId } from '../helpers/scenario';
import { useFreshDatabase, getTestPrisma } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { security } from '@/security';
import { MFA_CODE } from '@/lib/constants';

/** A deliberately WRONG 6-digit code (never the demo code). */
const WRONG_CODE = '000000';

/** The canonical RED action: `subscribe_investment` is STATICALLY RED → requires MFA. */
const RED_TOOL = 'subscribe_investment';
const RED_ARGS = { productId: 'prod_wenjiana', amount: 5000 };

/** The seeded funding account + balance (a successful ¥5000 subscription would change it). */
const CHECKING_ACCOUNT_ID = 'acct_checking';
const CHECKING_BALANCE = 23580;

/**
 * Drive ONE RED tool call through the full pipeline and return the awaiting-MFA action id.
 * Throws (rather than silently passing) when the gateway did NOT gate the call.
 */
async function driveRedAction(sessionId: string): Promise<{ agent: Agent; actionId: string }> {
  const agent = buildFauxAgent({
    sessionId,
    script: [tool(RED_TOOL, RED_ARGS), final('请完成安全验证。')],
  });
  const first = await runTurn({ sessionId, message: '买5000元稳健理财A', agent });

  const actionId = first.mfa?.actionId;
  if (actionId === undefined) {
    throw new Error(
      `expected a RED mfa_required outcome for ${RED_TOOL}, got cards: ${JSON.stringify(first.cards)}`,
    );
  }
  return { agent, actionId };
}

/** Submit the WRONG code three times against the SAME pending action (a fresh challenge per attempt). */
async function failMfaThreeTimes(agent: Agent, actionId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await verifyAction(agent, actionId, WRONG_CODE);
  }
}

describe('Scenario 10 — 连续错误MFA触发熔断 (circuit breaker)', () => {
  useFreshDatabase();

  it('a UNIQUE sessionId is used so the breaker lock cannot leak into other suites', () => {
    const sessionA = newSessionId();
    const sessionB = newSessionId();

    expect(sessionA).not.toBe('');
    expect(sessionA).not.toBe(sessionB);

    // A freshly-minted session starts unlocked with a clean failure counter (threshold = 3).
    const state = security.circuitBreaker.getState(sessionA);
    expect(state.failures).toBe(0);
    expect(state.max).toBe(3);
    expect(state.locked).toBe(false);
    expect(security.circuitBreaker.isLocked(sessionA)).toBe(false);
    expect(security.circuitBreaker.isLocked(sessionB)).toBe(false);
  });

  it('3 consecutive wrong MFA codes ("000000") on a RED action increment the failure counter', async () => {
    const sessionId = newSessionId();
    const { agent, actionId } = await driveRedAction(sessionId);
    const prisma = getTestPrisma();

    // 1st wrong code → attempt #1 recorded on the persisted challenge + breaker failure #1.
    const firstAttempt = await verifyAction(agent, actionId, WRONG_CODE);
    expect(firstAttempt.text).toContain('验证码错误');
    expect((await prisma.mfaChallenge.findUnique({ where: { actionId } }))?.attempts).toBe(1);
    expect(security.circuitBreaker.getState(sessionId).failures).toBe(1);

    // 2nd wrong code → attempt #2 + breaker failure #2.
    await verifyAction(agent, actionId, WRONG_CODE);
    expect((await prisma.mfaChallenge.findUnique({ where: { actionId } }))?.attempts).toBe(2);
    expect(security.circuitBreaker.getState(sessionId).failures).toBe(2);

    // 3rd wrong code → attempt #3 (threshold reached): the challenge is `locked`.
    const thirdAttempt = await verifyAction(agent, actionId, WRONG_CODE);
    const challenge = await prisma.mfaChallenge.findUnique({ where: { actionId } });
    expect(challenge?.attempts).toBe(3);
    expect(challenge?.maxAttempts).toBe(3);
    expect(challenge?.status).toBe('locked');
    expect(security.circuitBreaker.getState(sessionId).failures).toBe(3);

    // The human-facing outcome of the third attempt is the locked message (not "try again").
    expect(thirdAttempt.text).toContain('锁定');
  });

  it('the circuit breaker TRIPS and locks high-risk operations for the session', async () => {
    const sessionId = newSessionId();
    const { agent, actionId } = await driveRedAction(sessionId);

    // Not tripped before the failures.
    expect(security.circuitBreaker.isLocked(sessionId)).toBe(false);

    await failMfaThreeTimes(agent, actionId);

    expect(security.circuitBreaker.isLocked(sessionId)).toBe(true);
    const state = security.circuitBreaker.getState(sessionId);
    expect(state.locked).toBe(true);
    expect(state.failures).toBeGreaterThanOrEqual(3);
    expect(state.lockedAt).toBeTypeOf('number');
  });

  it('a CIRCUIT_BREAKER_TRIPPED SecurityEvent is emitted with severity high', async () => {
    const sessionId = newSessionId();
    const { agent, actionId } = await driveRedAction(sessionId);

    await failMfaThreeTimes(agent, actionId);

    const prisma = getTestPrisma();
    const trip = await prisma.securityEvent.findFirst({
      where: { sessionId, kind: 'CIRCUIT_BREAKER_TRIPPED' },
    });
    expect(trip).not.toBeNull();
    expect(trip?.severity).toBe('high');
    expect(trip?.message).toContain('锁定');

    // Each wrong code also logged an MFA_FAILURE event; `recordFailure` re-emits ONLY on the trip,
    // so exactly ONE trip event is persisted (the breaker is idempotent once locked).
    expect(
      await prisma.securityEvent.count({ where: { sessionId, kind: 'MFA_FAILURE' } }),
    ).toBe(3);
    expect(
      await prisma.securityEvent.count({ where: { sessionId, kind: 'CIRCUIT_BREAKER_TRIPPED' } }),
    ).toBe(1);
  });

  it('a subsequent RED attempt is refused with status "locked" and no execution occurs', async () => {
    const sessionId = newSessionId();
    const { agent, actionId } = await driveRedAction(sessionId);

    await failMfaThreeTimes(agent, actionId);

    const prisma = getTestPrisma();
    const holdingsBefore = await prisma.investmentHolding.count();
    const balanceBefore = (
      await prisma.account.findUnique({ where: { id: CHECKING_ACCOUNT_ID } })
    )?.balance;

    // Even the CORRECT demo code cannot authorize a locked session (the breaker is checked FIRST).
    const auth = await security.gateway.securityGateway.authorizeAction(actionId, {
      mfaCode: MFA_CODE,
    });
    expect(auth.ok).toBe(false);
    expect(auth.status).toBe('locked');
    expect(auth.message).toContain('熔断');

    // A fresh RED tool call for the same session is DENIED by the gateway with NO PendingAction.
    const pendingBefore = await prisma.pendingAction.count();
    const gate = await security.gateway.securityGateway.handleToolCall({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: RED_TOOL,
      args: RED_ARGS,
      userRequest: '',
    });
    expect(gate.evaluation.blocked).toBe(true);
    expect(gate.decision.kind).toBe('deny');
    expect(gate.action).toBeUndefined();
    expect(await prisma.pendingAction.count()).toBe(pendingBefore);

    // Nothing executed: no new holding and the funding account is untouched.
    expect(await prisma.investmentHolding.count()).toBe(holdingsBefore);
    const balanceAfter = (
      await prisma.account.findUnique({ where: { id: CHECKING_ACCOUNT_ID } })
    )?.balance;
    expect(balanceAfter).toBe(balanceBefore);
    expect(balanceAfter).toBe(CHECKING_BALANCE);
  });
});
