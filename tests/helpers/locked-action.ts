/**
 * tests/helpers/locked-action.ts — shared seeding, MFA ladder and DB probes for the
 * "MFA three-wrong-codes terminal lock" regression specs.
 *
 * WHY THIS EXISTS: every terminal-lock spec needs the SAME precondition (a REAL, plan-parked
 * action whose `PendingAction` row carries its `taskId`/`nodeId` LINK) plus the SAME gateway-driven
 * MFA ladder (wrong code #1/#2 → non-terminal `awaiting_mfa`, #3 → TERMINAL `locked`) and the SAME
 * fail-closed probes. Re-deriving that per spec drifts; this module is the single source.
 *
 * Every wrong code goes through `securityGateway.authorizeAction` — the ONLY MFA-code entry point.
 * `security/mfa.ts#verify` is NEVER called directly: it locks the CHALLENGE without persisting the
 * terminal action status, i.e. exactly the popup-loop regression these specs guard against.
 *
 * SCOPE: infrastructure only — no `describe`/`it`, and this module NEVER resets or seeds the
 * database. A spec still owns `resetDatabase()` in `beforeEach`: the circuit breaker is
 * OWNER-scoped (`user:<userId>`), so a lock left by a previous test would leak into the next one.
 */
import { expect } from 'vitest';

import { executeGatedTool, readPendingActionId } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import { MFA_CODE, MFA_MAX_ATTEMPTS } from '@/lib/constants';
import type { TaskPlan } from '@/lib/contracts/task';
import { centsToMoney } from '@/lib/money';
import { securityGateway, type AuthorizationResult } from '@/security/security-gateway';
import { getTestPrisma } from '@/tests/helpers/db';
import { ACCOUNTS, CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';

/** A WRONG 6-digit code — the conventional wrong submission every lock spec sends. */
export const WRONG_MFA_CODE = '000000';

/** The mock CORRECT code (`MFA_CODE`, `'123456'`) — a correct code must never bypass a lock. */
export const CORRECT_MFA_CODE = MFA_CODE;

/** The seeded 活期 account (`acct_checking`) — the account a parked transfer would debit. */
const CHECKING = ACCOUNTS.find(account => account.type === 'CHECKING')!;
/** Recipient 张伟 — resolves unambiguously from the seeded contacts. */
const ZHANGWEI = CONTACTS.find(contact => contact.name === '张伟')!;
/** The recipient name seeded into a plan's transfer node. */
const RECIPIENT_NAME = ZHANGWEI.name;
/** The single node id every seeded plan uses. */
const NODE_ID = 'n1';
/** Transfer ABOVE the ¥1,000 confirmation-only limit ⇒ RED ⇒ parks `awaiting_mfa`. */
const RED_AMOUNT = '5000';
/** Transfer BELOW the limit ⇒ YELLOW ⇒ parks `pending` with `requiresMfa:false`. */
const CONFIRM_ONLY_AMOUNT = '500';

/**
 * A parked plan node: the owning session, the plan (`AgentTask.id`), the node (`n1`) and the
 * `PendingAction` the gateway created for it.
 */
export interface ParkedPlanAction {
  sessionId: string;
  taskId: string;
  nodeId: string;
  actionId: string;
}

/**
 * The canonical demo session id (`demo:user_liming`) — also the circuit-breaker OWNER key.
 * Use it whenever a lock spec must name the session it drives; call it AFTER `resetDatabase()`.
 */
export async function demoSessionId(): Promise<string> {
  return (await getDemoSession(DEMO_USER_ID)).sessionId;
}

/* ------------------------------------------------------------------------------ plan seeding */

/**
 * The gateway-authorized per-node runner. It MUST forward the node identity
 * (`ctx.taskId`/`ctx.nodeId`): that is what scopes the parked action to its plan node.
 */
function gatewayRunTool(sessionId: string, userRequest: string): PlanRunTool {
  return (toolName, args, ctx) =>
    executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName,
      args,
      userRequest,
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });
}

/** Seed ONE `transfer_money` node through the PRODUCTION `submit_plan` runner and return the park. */
async function parkTransferPlan(amount: string, goal: string): Promise<ParkedPlanAction> {
  const sessionId = await demoSessionId();
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    { goal, nodes: [{ id: NODE_ID, name: `给${RECIPIENT_NAME}转账`, dependencies: [], kind: 'tool', tool: 'transfer_money', args: { name: RECIPIENT_NAME, amount } }] },
    { sessionId, runTool: gatewayRunTool(sessionId, goal) },
  );
  expect(result.ok, `runSubmitPlan rejected the ¥${amount} plan: ${result.error}`).toBe(true);
  const plan = result.data as TaskPlan;
  expect(plan.status, `plan ${plan.id} must park a node awaiting a decision`).toBe('waiting_confirmation');
  const node = plan.results.find(candidate => candidate.id === NODE_ID);
  expect(node, `plan ${plan.id} recorded no node '${NODE_ID}'`).toBeDefined();
  const actionId = readPendingActionId(node?.output);
  expect(typeof actionId, `the ¥${amount} transfer node parked no PendingAction`).toBe('string');
  return { sessionId, taskId: plan.id, nodeId: NODE_ID, actionId: actionId! };
}

/**
 * Seed a single-node plan whose ¥5,000 transfer to 张伟 is RED, so the gateway parks it in
 * `awaiting_mfa` with a real `taskId`/`nodeId` LINK. This is the precondition of every
 * "three wrong codes lock the action" spec; the plan status is asserted to be `waiting_confirmation`.
 */
export async function parkRedTransferPlan(
  goal: string = `给${RECIPIENT_NAME}转${RED_AMOUNT}元`,
): Promise<ParkedPlanAction> {
  const parked = await parkTransferPlan(RED_AMOUNT, goal);
  const row = await pendingActionRow(parked.actionId);
  expect(row?.status, 'a >¥1,000 transfer must park in awaiting_mfa').toBe('awaiting_mfa');
  expect(row?.riskLevel, 'a >¥1,000 transfer must be RED').toBe('RED');
  expect(row?.requiresMfa, 'a RED transfer must require strong verification').toBe(true);
  return parked;
}

/**
 * Seed a single-node plan whose ¥500 transfer to 张伟 is YELLOW, so it parks in `pending` with
 * `requiresMfa:false`. Use it when a lock spec compares "confirmation-only" against RED but MUST
 * drive the SAME gateway decision path.
 */
export async function parkConfirmOnlyTransfer(
  amount: string = CONFIRM_ONLY_AMOUNT,
): Promise<ParkedPlanAction> {
  const parked = await parkTransferPlan(amount, `给${RECIPIENT_NAME}转${amount}元`);
  const row = await pendingActionRow(parked.actionId);
  expect(row?.status, 'a ≤¥1,000 transfer must park in pending (confirmation only)').toBe('pending');
  expect(row?.requiresMfa, 'a YELLOW transfer must not require an MFA code').toBe(false);
  return parked;
}

/* ------------------------------------------------------------------------------- MFA ladder */

/**
 * Submit ONE code through the gateway (`authorizeAction`) — never through `security/mfa.ts#verify`.
 * The returned `AuthorizationResult` is the raw decision a spec asserts on (`status`, `code`,
 * `failure.reason`, `failure.attemptsLeft`).
 */
export async function submitMfaCode(
  actionId: string,
  sessionId: string,
  code: string,
): Promise<AuthorizationResult> {
  return securityGateway.authorizeAction(actionId, { userId: DEMO_USER_ID, sessionId, mfaCode: code });
}

/**
 * Submit `WRONG_MFA_CODE` `MFA_MAX_ATTEMPTS` (3) times and return the results IN ORDER
 * (1st → 2nd → 3rd), so a spec can assert the per-attempt ladder without re-submitting.
 * Assumes a FRESH breaker: it does not reset owner-scoped failures.
 */
export async function exhaustMfaAttempts(
  actionId: string,
  sessionId: string,
): Promise<AuthorizationResult[]> {
  const attempts: AuthorizationResult[] = [];
  for (let attempt = 1; attempt <= MFA_MAX_ATTEMPTS; attempt += 1) {
    attempts.push(await submitMfaCode(actionId, sessionId, WRONG_MFA_CODE));
  }
  return attempts;
}

/**
 * Reach the TERMINAL lock: exhaust the attempt limit, then assert the LAST attempt is
 * `status:'locked'` AND the lock is DURABLE on the `PendingAction` row. Use it when a spec's
 * subject is what happens AFTER the lock (surfacing, re-prompt, further attempts), not the ladder.
 */
export async function lockAction(actionId: string, sessionId: string): Promise<void> {
  const attempts = await exhaustMfaAttempts(actionId, sessionId);
  const terminal = attempts[attempts.length - 1];
  expect(
    terminal?.status,
    `attempt ${MFA_MAX_ATTEMPTS} must be the TERMINAL lock (got ${terminal?.status}:${terminal?.code})`,
  ).toBe('locked');
  const row = await pendingActionRow(actionId);
  expect(row?.status, 'the lock must be persisted on the PendingAction row').toBe('locked');
}

/* ------------------------------------------------------------------------------------ probes */

/** The persisted `PendingAction` row (`null` when absent) — the durable status/reason probe. */
export function pendingActionRow(actionId: string) {
  return getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
}

/** Every `MfaChallenge` row for an action (`attempts`/`status` ladder probe; one row per action). */
export function mfaChallengesFor(actionId: string) {
  return getTestPrisma().mfaChallenge.findMany({ where: { actionId } });
}

/** The 活期 account's CURRENT balance as a CNY string — a refused transfer must never move it. */
export async function checkingBalance(): Promise<string> {
  const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return centsToMoney(account.balanceMinor);
}

/** Every ledger row paid to 张伟 — the "money moved exactly once (or never)" probe. */
export function zhangweiTransfers() {
  return getTestPrisma().transaction.findMany({ where: { counterpartyId: ZHANGWEI.id } });
}

/** Audit rows for a session (all sessions when omitted) — a refused write must add none. */
export function auditLogCount(sessionId?: string) {
  return getTestPrisma().auditLog.count({ where: sessionId === undefined ? {} : { sessionId } });
}

/** `SecurityEvent` rows of one `kind` for a session, oldest first (`MFA_FAILURE`, `locked`, …). */
export function securityEventsOfKind(sessionId: string, kind: string) {
  return getTestPrisma().securityEvent.findMany({
    where: { sessionId, kind },
    orderBy: { timestamp: 'asc' },
  });
}

/** The total ledger row count — the "no new transaction was written" fail-closed probe. */
export function transactionsCount() {
  return getTestPrisma().transaction.count();
}
