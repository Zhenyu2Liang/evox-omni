/**
 * Unit: security/security-gateway — the code-enforced chokepoint (evaluate → decide → pending → authorize).
 *
 * Targets `@/security/security-gateway`: securityGateway.{evaluate,decide,createPendingAction,
 * serializeBlockReason,parseBlockReason,authorizeAction,cancelAction,handleToolCall},
 * buildPendingActionSummary, BLOCK_REASON_PREFIX (+ types GatewayContext, SecurityGateway,
 * AuthorizationResult, ToolCallAuthorization).
 *
 * `decide` / `serializeBlockReason` / `parseBlockReason` / `buildPendingActionSummary` are PURE.
 * `evaluate` / `createPendingAction` / `authorizeAction` / `cancelAction` / `handleToolCall` persist
 * PendingAction rows and consult the circuit breaker → require test SQLite via ../helpers/db.
 * The gateway NEVER executes the business operation — it only authorizes.
 *
 * Persistence rule under test: a gated call is persisted with status `pending` when the tier is
 * YELLOW (confirmation only) and `awaiting_mfa` when the evaluation requires MFA (RED).
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { MFA_CODE, MFA_MAX_ATTEMPTS, RISK_LABEL } from '@/lib/constants';
import { formatCNY } from '@/lib/money';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import type {
  PendingAction,
  SecurityDecision,
  SecurityEvaluation,
} from '@/lib/contracts/security';
import { security } from '@/security';
import {
  BLOCK_REASON_PREFIX,
  buildPendingActionSummary,
  securityGateway,
  type GatewayContext,
} from '@/security/security-gateway';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { newSessionId } from '../../helpers/scenario';

useFreshDatabase();

/** The seeded checking account (`tests/helpers/fixtures.ts` ACCOUNTS[0]). */
const CHECKING_ACCOUNT_ID = 'acct_checking';
const CHECKING_BALANCE = 23580;

/* ------------------------------------------------------------------ helpers */

/** Proposed tool call context; `sessionId` defaults to a fresh id so breaker state never leaks. */
function ctxFor(
  toolName: ToolName,
  args: Record<string, unknown> = {},
  sessionId: string = newSessionId(),
): GatewayContext {
  return { sessionId, userId: DEMO_USER_ID, toolName, args, userRequest: '演示请求' };
}

/** A hand-built `SecurityEvaluation` literal for the PURE cases (no DB, no engine). */
function evaluation(
  toolName: ToolName,
  tier: RiskLevel,
  overrides: Partial<SecurityEvaluation> = {},
): SecurityEvaluation {
  return {
    toolName,
    tier,
    requiresConfirmation: tier !== 'GREEN',
    requiresMfa: tier === 'RED',
    reasons: [],
    blocked: tier !== 'GREEN',
    ...overrides,
  };
}

/** Current balance of the seeded checking account (unchanged ⇔ no money moved). */
async function checkingBalance(): Promise<number> {
  const account = await getTestPrisma().account.findUnique({ where: { id: CHECKING_ACCOUNT_ID } });
  if (!account) throw new Error('test seed is missing the checking account');
  return account.balance;
}

async function countTransactions(): Promise<number> {
  return getTestPrisma().transaction.count();
}

/** Persist a YELLOW gated transfer (¥200, no MFA) for the given session. */
async function createYellowAction(sessionId: string): Promise<PendingAction> {
  const ctx = ctxFor('transfer_money', { amount: 200, contactId: 'contact_zhangwei' }, sessionId);
  return securityGateway.createPendingAction(ctx, await securityGateway.evaluate(ctx));
}

/** Persist a RED gated transfer (¥5000, MFA required) for the given session. */
async function createRedAction(sessionId: string): Promise<PendingAction> {
  const ctx = ctxFor('transfer_money', { amount: 5000, contactId: 'contact_zhangwei' }, sessionId);
  return securityGateway.createPendingAction(ctx, await securityGateway.evaluate(ctx));
}

/* ---------------------------------------------------------- pure test literals */

const PURE_ACTION: PendingAction = {
  id: 'pa_pure_1',
  sessionId: 'sess_pure',
  toolName: 'transfer_money',
  args: { amount: 200, toName: '张伟' },
  tier: 'YELLOW',
  requiresMfa: false,
  status: 'pending',
  summary: {
    title: '转账',
    toolName: 'transfer_money',
    tier: 'YELLOW',
    fields: [],
    requiresMfa: false,
  },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const PURE_DECISION: SecurityDecision = {
  kind: 'require_confirmation',
  tier: 'YELLOW',
  evaluation: evaluation('transfer_money', 'YELLOW', { requiresMfa: false }),
  message: '该操作需你确认后方可执行。',
};

/* ------------------------------------------------------------------- specs */

describe('security-gateway · decide (pure: tier → decision kind)', () => {
  it('GREEN evaluation → decision kind allow with a user-facing message', () => {
    const ev = evaluation('get_balance', 'GREEN');
    const decision = securityGateway.decide(ev, ctxFor('get_balance'));

    expect(decision.kind).toBe('allow');
    expect(decision.tier).toBe('GREEN');
    expect(decision.evaluation).toBe(ev);
    expect(typeof decision.message).toBe('string');
    expect(decision.message.length).toBeGreaterThan(0);
    expect(decision.pendingActionId).toBeUndefined();
  });

  it('YELLOW evaluation → decision kind require_confirmation', () => {
    const ev = evaluation('transfer_money', 'YELLOW', { requiresMfa: false });
    const decision = securityGateway.decide(ev, ctxFor('transfer_money', { amount: 200 }));

    expect(decision.kind).toBe('require_confirmation');
    expect(decision.tier).toBe('YELLOW');
    expect(decision.evaluation).toBe(ev);
  });

  it('RED evaluation → decision kind require_mfa', () => {
    const ev = evaluation('transfer_money', 'RED', { requiresMfa: true });
    const decision = securityGateway.decide(ev, ctxFor('transfer_money', { amount: 5000 }));

    expect(decision.kind).toBe('require_mfa');
    expect(decision.tier).toBe('RED');
    expect(decision.evaluation).toBe(ev);
  });

  it('every decision carries a safe user-facing message (no MFA code, no internals)', () => {
    const green = evaluation('get_balance', 'GREEN');
    const yellow = evaluation('transfer_money', 'YELLOW', { requiresMfa: false });
    const red = evaluation('transfer_money', 'RED', { requiresMfa: true });
    const locked = evaluation('get_balance', 'GREEN', {
      blocked: true,
      blockReason: 'HIGH_RISK_BLOCKED',
    });

    const kinds = [
      securityGateway.decide(green, ctxFor('get_balance')).kind,
      securityGateway.decide(yellow, ctxFor('transfer_money', { amount: 200 })).kind,
      securityGateway.decide(red, ctxFor('transfer_money', { amount: 5000 })).kind,
      securityGateway.decide(locked, ctxFor('get_balance')).kind,
    ];
    expect(kinds).toEqual(['allow', 'require_confirmation', 'require_mfa', 'deny']);

    for (const ev of [green, yellow, red, locked]) {
      const decision = securityGateway.decide(ev, ctxFor(ev.toolName));
      expect(typeof decision.message).toBe('string');
      expect(decision.message.length).toBeGreaterThan(0);
      expect(decision.message).not.toContain(MFA_CODE);
    }
  });
});

describe('security-gateway · block reason round-trip (pure)', () => {
  it('serializeBlockReason prefixes with BLOCK_REASON_PREFIX and embeds actionId + decisionKind', () => {
    const reason = securityGateway.serializeBlockReason(PURE_DECISION, PURE_ACTION);

    expect(reason.startsWith(BLOCK_REASON_PREFIX)).toBe(true);
    const payload = JSON.parse(reason.slice(BLOCK_REASON_PREFIX.length)) as Record<string, unknown>;
    expect(payload).toEqual({ actionId: PURE_ACTION.id, decisionKind: PURE_DECISION.kind });
  });

  it('parseBlockReason(serializeBlockReason(decision, action)) → { actionId, decisionKind } (exact round-trip)', () => {
    const reason = securityGateway.serializeBlockReason(PURE_DECISION, PURE_ACTION);

    expect(securityGateway.parseBlockReason(reason)).toEqual({
      actionId: PURE_ACTION.id,
      decisionKind: PURE_DECISION.kind,
    });
  });

  it('parseBlockReason returns null for a plain non-block string', () => {
    expect(securityGateway.parseBlockReason('')).toBeNull();
    expect(securityGateway.parseBlockReason('随便一句话，不是安全阻断原因')).toBeNull();
    // Unprefixed JSON is NOT a block reason.
    expect(
      securityGateway.parseBlockReason(JSON.stringify({ actionId: 'pa_1', decisionKind: 'deny' })),
    ).toBeNull();
  });

  it('parseBlockReason returns null for a malformed block string (missing fields)', () => {
    const prefix = BLOCK_REASON_PREFIX;
    // Malformed JSON after the prefix.
    expect(securityGateway.parseBlockReason(`${prefix}{not json`)).toBeNull();
    // Valid JSON but not an object.
    expect(securityGateway.parseBlockReason(`${prefix}null`)).toBeNull();
    expect(securityGateway.parseBlockReason(`${prefix}"a string"`)).toBeNull();
    // Missing / empty actionId.
    expect(
      securityGateway.parseBlockReason(`${prefix}${JSON.stringify({ decisionKind: 'require_mfa' })}`),
    ).toBeNull();
    expect(
      securityGateway.parseBlockReason(
        `${prefix}${JSON.stringify({ actionId: '', decisionKind: 'require_mfa' })}`,
      ),
    ).toBeNull();
    // Missing / invalid decisionKind.
    expect(securityGateway.parseBlockReason(`${prefix}${JSON.stringify({ actionId: 'pa_1' })}`)).toBeNull();
    expect(
      securityGateway.parseBlockReason(
        `${prefix}${JSON.stringify({ actionId: 'pa_1', decisionKind: 'bogus' })}`,
      ),
    ).toBeNull();
  });
});

describe('security-gateway · evaluate (needs test SQLite)', () => {
  it('GREEN tool (get_balance) → tier GREEN, not blocked, no confirmation / MFA', async () => {
    const ev = await securityGateway.evaluate(ctxFor('get_balance'));

    expect(ev.toolName).toBe('get_balance');
    expect(ev.tier).toBe('GREEN');
    expect(ev.blocked).toBe(false);
    expect(ev.requiresConfirmation).toBe(false);
    expect(ev.requiresMfa).toBe(false);
    expect(ev.blockReason).toBeUndefined();
  });

  it('transfer_money ¥200 (seeded day total 0) → YELLOW, blocked, confirmation but no MFA', async () => {
    const ev = await securityGateway.evaluate(ctxFor('transfer_money', { amount: 200 }));

    expect(ev.tier).toBe('YELLOW');
    expect(ev.blocked).toBe(true);
    expect(ev.requiresConfirmation).toBe(true);
    expect(ev.requiresMfa).toBe(false);
    expect(ev.amount).toBe(200);
    expect(ev.dailyTotal).toBe(0);
  });

  it('transfer_money ¥5000 → RED, blocked, requires strong verification', async () => {
    const ev = await securityGateway.evaluate(ctxFor('transfer_money', { amount: 5000 }));

    expect(ev.tier).toBe('RED');
    expect(ev.blocked).toBe(true);
    expect(ev.requiresConfirmation).toBe(true);
    expect(ev.requiresMfa).toBe(true);
  });

  it('locked session → blocked with blockReason HIGH_RISK_BLOCKED (even for a GREEN tool)', async () => {
    const sessionId = newSessionId();
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
      await security.circuitBreaker.recordFailure(sessionId);
    }
    expect(security.circuitBreaker.isLocked(sessionId)).toBe(true);

    const ctx = ctxFor('get_balance', {}, sessionId);
    const ev = await securityGateway.evaluate(ctx);

    expect(ev.blocked).toBe(true);
    expect(ev.blockReason).toBe('HIGH_RISK_BLOCKED');
    expect(securityGateway.decide(ev, ctx).kind).toBe('deny');
  });
});

describe('security-gateway · createPendingAction (needs test SQLite)', () => {
  it("persists a PendingAction row (YELLOW → 'pending', RED → 'awaiting_mfa') and returns it with the summary", async () => {
    const yellowCtx = ctxFor('transfer_money', { amount: 200, contactId: 'contact_zhangwei' });
    const yellowEv = await securityGateway.evaluate(yellowCtx);
    expect(yellowEv.tier).toBe('YELLOW');

    const yellow = await securityGateway.createPendingAction(yellowCtx, yellowEv);
    expect(yellow.id).toBeTruthy();
    expect(yellow.status).toBe('pending');
    expect(yellow.requiresMfa).toBe(false);
    expect(yellow.tier).toBe('YELLOW');
    expect(yellow.sessionId).toBe(yellowCtx.sessionId);
    expect(yellow.toolName).toBe('transfer_money');

    const yellowRow = await getTestPrisma().pendingAction.findUnique({ where: { id: yellow.id } });
    expect(yellowRow?.status).toBe('pending');
    expect(yellowRow?.userId).toBe(DEMO_USER_ID);

    const redCtx = ctxFor('transfer_money', { amount: 5000, contactId: 'contact_zhangwei' });
    const redEv = await securityGateway.evaluate(redCtx);
    expect(redEv.tier).toBe('RED');

    const red = await securityGateway.createPendingAction(redCtx, redEv);
    expect(red.status).toBe('awaiting_mfa');
    expect(red.requiresMfa).toBe(true);

    const redRow = await getTestPrisma().pendingAction.findUnique({ where: { id: red.id } });
    expect(redRow?.status).toBe('awaiting_mfa');

    // RED also gets a code-free MFA challenge up-front (the code lives server-side only).
    const challenge = await getTestPrisma().mfaChallenge.findUnique({ where: { actionId: red.id } });
    expect(challenge).not.toBeNull();
    expect(challenge?.code).toBe(MFA_CODE);
    // YELLOW needs no challenge.
    expect(await getTestPrisma().mfaChallenge.findUnique({ where: { actionId: yellow.id } })).toBeNull();
  });

  it('buildPendingActionSummary for transfer_money includes the fields 收款人 / 金额 / 账户 / 风险等级', async () => {
    const ctx = ctxFor('transfer_money', { amount: 200, toName: '张伟' });
    const ev = await securityGateway.evaluate(ctx);
    const summary = buildPendingActionSummary(ctx, ev);

    expect(summary.fields.map((f) => f.label)).toEqual(['收款人', '金额', '账户', '风险等级']);
    const byLabel = new Map(summary.fields.map((f) => [f.label, f.value]));
    expect(byLabel.get('收款人')).toBe('张伟');
    expect(byLabel.get('金额')).toBe(formatCNY(200));
    expect(byLabel.get('账户')).toBe('默认活期账户');
    expect(byLabel.get('风险等级')).toBe(RISK_LABEL.YELLOW);

    expect(summary.title).toBe(security.permission.getToolPolicy('transfer_money').description);
    expect(summary.toolName).toBe('transfer_money');
    expect(summary.tier).toBe('YELLOW');
    expect(summary.amount).toBe(200);
  });

  it('RED action summary sets requiresMfa true + a code-free mfaHint; YELLOW summary sets requiresMfa false', async () => {
    const yellowCtx = ctxFor('transfer_money', { amount: 200, toName: '张伟' });
    const yellowSummary = buildPendingActionSummary(
      yellowCtx,
      await securityGateway.evaluate(yellowCtx),
    );
    expect(yellowSummary.requiresMfa).toBe(false);
    expect(yellowSummary.mfaHint).toBeUndefined();

    const redCtx = ctxFor('transfer_money', { amount: 5000, toName: '张伟' });
    const redSummary = buildPendingActionSummary(redCtx, await securityGateway.evaluate(redCtx));
    expect(redSummary.requiresMfa).toBe(true);
    expect(typeof redSummary.mfaHint).toBe('string');
    expect(redSummary.mfaHint).not.toContain(MFA_CODE);
    for (const field of redSummary.fields) {
      expect(field.value).not.toContain(MFA_CODE);
    }
    expect(redSummary.title).not.toContain(MFA_CODE);
  });

  it('the persisted args are the validated originals (used later for the authorized execution path)', async () => {
    const args = { amount: 200, contactId: 'contact_zhangwei', remark: '测试备注' };
    const ctx = ctxFor('transfer_money', args);
    const ev = await securityGateway.evaluate(ctx);

    const action = await securityGateway.createPendingAction(ctx, ev);
    expect(action.args).toEqual(args);

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row).not.toBeNull();
    expect(JSON.parse(row?.argsJson ?? 'null')).toEqual(args);
  });
});

describe('security-gateway · authorizeAction (needs test SQLite)', () => {
  it("YELLOW action authorizes with no code → ok true, status 'confirmed'", async () => {
    const sessionId = newSessionId();
    const action = await createYellowAction(sessionId);
    expect(action.requiresMfa).toBe(false);

    const res = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('confirmed');
    expect(res.actionId).toBe(action.id);
    expect(res.requiresMfa).toBe(false);
    expect(res.mfaResult).toBe('not_required');
    expect(res.message).not.toContain(MFA_CODE);

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('confirmed');
  });

  it("RED action without mfaCode → ok false, status 'awaiting_mfa' (nothing executed)", async () => {
    const sessionId = newSessionId();
    const action = await createRedAction(sessionId);
    const balanceBefore = await checkingBalance();
    const txBefore = await countTransactions();

    const res = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('awaiting_mfa');
    expect(res.requiresMfa).toBe(true);
    expect(res.mfaResult).toBeUndefined();

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('awaiting_mfa');
    expect(await checkingBalance()).toBe(balanceBefore);
    expect(await countTransactions()).toBe(txBefore);
  });

  it("RED action with a wrong code → ok false, mfaResult 'failed', breaker failure recorded", async () => {
    const sessionId = newSessionId();
    const action = await createRedAction(sessionId);
    expect(security.circuitBreaker.getState(sessionId).failures).toBe(0);

    const res = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId, mfaCode: '000000' });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('awaiting_mfa');
    expect(res.requiresMfa).toBe(true);
    expect(res.mfaResult).toBe('failed');

    expect(security.circuitBreaker.getState(sessionId).failures).toBe(1);
    expect(security.circuitBreaker.isLocked(sessionId)).toBe(false);

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('awaiting_mfa');
  });

  it("RED action with code '123456' → ok true, status 'confirmed', mfaResult 'success'", async () => {
    const sessionId = newSessionId();
    const action = await createRedAction(sessionId);

    const res = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId, mfaCode: MFA_CODE });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('confirmed');
    expect(res.requiresMfa).toBe(true);
    expect(res.mfaResult).toBe('success');
    expect(res.message).not.toContain(MFA_CODE);

    // A success resets the consecutive-failure counter.
    expect(security.circuitBreaker.getState(sessionId).failures).toBe(0);

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('confirmed');
  });

  it("locked session (breaker tripped) → refused, status 'locked', even with the correct code", async () => {
    const sessionId = newSessionId();
    const action = await createRedAction(sessionId);

    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
      await security.circuitBreaker.recordFailure(sessionId);
    }
    expect(security.circuitBreaker.isLocked(sessionId)).toBe(true);

    const res = await securityGateway.authorizeAction(action.id, { userId: DEMO_USER_ID, sessionId, mfaCode: MFA_CODE });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('locked');
    expect(res.mfaResult).toBeUndefined();
    expect(res.message).not.toContain(MFA_CODE);

    // The correct code did NOT authorize the action.
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('awaiting_mfa');
  });
});

describe('security-gateway · cancelAction (needs test SQLite)', () => {
  it("cancelAction(id) → status 'cancelled'; the business op is never executed", async () => {
    const sessionId = newSessionId();
    const action = await createYellowAction(sessionId);
    const balanceBefore = await checkingBalance();
    const txBefore = await countTransactions();

    const cancelled = await securityGateway.cancelAction(action.id, { userId: DEMO_USER_ID, sessionId });

    expect(cancelled.id).toBe(action.id);
    expect(cancelled.status).toBe('cancelled');

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('cancelled');
    expect(await checkingBalance()).toBe(balanceBefore);
    expect(await countTransactions()).toBe(txBefore);
  });

  it('cancelling an unknown or already-terminal action surfaces an AppError', async () => {
    const missing = await securityGateway
      .cancelAction('pa_does_not_exist', { userId: DEMO_USER_ID, sessionId: newSessionId() })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(AppError);
    expect((missing as AppError).code).toBe('NOT_FOUND');

    const sessionId = newSessionId();
    const action = await createYellowAction(sessionId);
    await securityGateway.cancelAction(action.id, { userId: DEMO_USER_ID, sessionId }); // → cancelled (now terminal)

    const again = await securityGateway
      .cancelAction(action.id, { userId: DEMO_USER_ID, sessionId })
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(AppError);
    expect((again as AppError).code).toBe('CONFLICT');

    // Terminal status was NOT overwritten.
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id: action.id } });
    expect(row?.status).toBe('cancelled');
  });
});

describe('security-gateway · handleToolCall composition', () => {
  it('GREEN tool → evaluation not blocked, decision allow, no PendingAction, no blockReason', async () => {
    const res = await securityGateway.handleToolCall(ctxFor('get_balance'));

    expect(res.evaluation.tier).toBe('GREEN');
    expect(res.evaluation.blocked).toBe(false);
    expect(res.decision.kind).toBe('allow');
    expect(res.action).toBeUndefined();
    expect(res.blockReason).toBeUndefined();
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });

  it('YELLOW tool → blocked: PendingAction persisted + a round-trippable blockReason', async () => {
    const res = await securityGateway.handleToolCall(
      ctxFor('transfer_money', { amount: 200, contactId: 'contact_zhangwei' }),
    );

    expect(res.evaluation.blocked).toBe(true);
    expect(res.decision.kind).toBe('require_confirmation');
    expect(res.action).toBeDefined();
    expect(res.action?.status).toBe('pending');
    expect(res.decision.pendingActionId).toBe(res.action?.id);
    expect(res.blockReason?.startsWith(BLOCK_REASON_PREFIX)).toBe(true);

    expect(securityGateway.parseBlockReason(res.blockReason ?? '')).toEqual({
      actionId: res.action?.id,
      decisionKind: 'require_confirmation',
    });
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
  });

  it('RED tool → blocked with decision kind require_mfa', async () => {
    const res = await securityGateway.handleToolCall(
      ctxFor('transfer_money', { amount: 5000, contactId: 'contact_zhangwei' }),
    );

    expect(res.evaluation.tier).toBe('RED');
    expect(res.evaluation.blocked).toBe(true);
    expect(res.decision.kind).toBe('require_mfa');
    expect(res.action?.status).toBe('awaiting_mfa');
    expect(securityGateway.parseBlockReason(res.blockReason ?? '')).toEqual({
      actionId: res.action?.id,
      decisionKind: 'require_mfa',
    });
  });

  it('handleToolCall never invokes banking-sdk / never moves money — it only evaluates, persists and blocks', async () => {
    const txBefore = await countTransactions();
    expect(await checkingBalance()).toBe(CHECKING_BALANCE);

    await securityGateway.handleToolCall(
      ctxFor('transfer_money', { amount: 5000, contactId: 'contact_zhangwei' }, newSessionId()),
    );
    await securityGateway.handleToolCall(
      ctxFor('transfer_money', { amount: 200, contactId: 'contact_mama' }, newSessionId()),
    );
    await securityGateway.handleToolCall(ctxFor('get_balance', {}, newSessionId()));

    expect(await checkingBalance()).toBe(CHECKING_BALANCE);
    expect(await countTransactions()).toBe(txBefore);
  });
});
