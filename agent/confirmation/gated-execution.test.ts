/**
 * `agent/confirmation/gated-execution.test.ts` — the plan layer's gated-tool PORT contract.
 *
 * WHY THIS EXISTS: every production plan `runTool` port (`agent/index.ts#taskRunToolFor`, the durable
 * drivers, the scheduler, `submit_plan`'s runner) returns the value of `executeGatedTool` VERBATIM and
 * the planner (`planner/node-outcome.ts#settleToolNode`, `planner/failure.ts`) reads the structured
 * `failure` / `actionStatus` fields off it. Two properties therefore have to hold AT THIS BOUNDARY:
 *
 *  A. a refusal that the security gateway already settled arrives as TYPED facts (`failure` from the
 *     gateway's opaque block payload, `actionStatus` from the PERSISTED `PendingAction` row) — never as
 *     a `__SECURITY_BLOCK__…` payload, a `decisionKind` fragment, `[object Object]`, JSON or a stack
 *     frame in a RENDERABLE field (`error` / `summary` / the node result);
 *  B. a SETTLED-but-reusable row (`failed` / `locked` / `cancelled`) is NOT "already represented": an
 *     explicit user retry re-enters the gateway for a FRESH authorization (and a NEW `PendingAction`),
 *     while a still-decided row (`pending` / `awaiting_mfa` / `confirmed`) and recorded evidence
 *     (`executed` / `needs_reconciliation`) keep their existing single-action semantics — and a
 *     `locked` row is never re-activated by any of it.
 */
import { describe, expect, it } from 'vitest';

import { confirmAction, getOrCreateSession, retryTask } from '@/agent';
import { executeGatedTool } from '@/agent/confirmation/gated-execution';
import type { GatewayContext } from '@/security/security-gateway';
import { createTaskGraph } from '@/lib/db/repositories/task';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { isLockedRefusal, toPlanFailure } from '@/planner/failure';
import { settleToolNode } from '@/planner/node-outcome';
import { getTestPrisma, useFreshDatabase as registerDatabaseReset } from '@/tests/helpers/db';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  exhaustMfaAttempts,
  lockAction,
  parkRedTransferPlan,
  pendingActionRow,
  type ParkedPlanAction,
} from '@/tests/helpers/locked-action';

registerDatabaseReset();

/**
 * A gated `transfer_money` call for the parked plan node — the port the planner would call. The
 * arguments come from the node's own recorded invocation so the call reuses its request identity.
 */
async function portContext(parked: ParkedPlanAction, amount: string): Promise<GatewayContext> {
  const invocation = await getTestPrisma().toolInvocation.findFirstOrThrow({
    where: { taskId: parked.taskId, nodeId: parked.nodeId },
  });
  return {
    sessionId: parked.sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: JSON.parse(invocation.argsJson) as Record<string, unknown>,
    userRequest: `转账${amount}元`,
    taskId: parked.taskId,
    nodeId: parked.nodeId,
  } as GatewayContext;
}

/** The single-node plan spec matching a parked node, for the plan-layer projection. */
function nodeSpec(parked: ParkedPlanAction): TaskNodeSpec {
  return { id: parked.nodeId, name: 'Transfer', kind: 'tool', tool: 'transfer_money', args: {}, dependencies: [] } as TaskNodeSpec;
}

/** Every user-visible / serialized string of an outcome, joined for the "no internals leaked" probes. */
function visibleText(...values: unknown[]): string {
  return values
    .map(value => (typeof value === 'string' ? value : JSON.stringify(value) ?? ''))
    .join('\n');
}

/** The probes no renderable text may ever contain. */
function expectNoInternals(text: string): void {
  expect(text).not.toContain('__SECURITY_BLOCK__');
  expect(text).not.toContain('decisionKind');
  expect(text).not.toContain('[object Object]');
  expect(/\n\s+at\s/.test(text), 'a stack frame reached a renderable field').toBe(false);
}

describe('plan tool port: structured refusal facts', () => {
  it('carries a settled lock as typed facts and never re-activates the locked row', async () => {
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);
    const lockedBefore = await pendingActionRow(parked.actionId);
    expect(lockedBefore?.status).toBe('locked');

    const outcome = await executeGatedTool(await portContext(parked, '5000'));

    // ── Gap A: the gateway's typed refusal reaches the port as structured facts …
    expect(outcome.ok).toBe(false);
    expect(outcome.failure, 'a settled refusal must carry a typed failure').toBeDefined();
    expect(outcome.failure?.code).toBe('CIRCUIT_OPEN');
    expect(outcome.failure?.reason).toBe('circuit_open');
    expect(isLockedRefusal(outcome.failure), 'the planner must classify this as a settled lock').toBe(true);
    // … and `actionStatus` is the PERSISTED row's status, not a decision intent.
    expect(outcome.actionStatus).toBe('locked');
    expect(outcome.pendingActionId).toBeUndefined();
    expect(outcome.requiresConfirmation).toBe(false);
    expectNoInternals(visibleText(outcome.error, outcome.summary, outcome));

    // ── Gap B: a `locked` row is not "represented" — it is never CASed back to an open status.
    const lockedAfter = await pendingActionRow(parked.actionId);
    expect(lockedAfter?.status).toBe('locked');
    expect(lockedAfter?.updatedAt.toISOString()).toBe(lockedBefore?.updatedAt.toISOString());
    const rows = await getTestPrisma().pendingAction.findMany({ where: { taskId: parked.taskId } });
    expect(rows, 'a locked node must not mint a second authorization').toHaveLength(1);
    expect(rows.filter(row => row.status === 'pending' || row.status === 'awaiting_mfa')).toHaveLength(0);

    // ── The plan-node projection keeps the facts and stays renderable.
    const node = settleToolNode(nodeSpec(parked), outcome, 1, 2);
    expect(node.failure?.code).toBe('CIRCUIT_OPEN');
    expect(node.failure?.reason).toBe('circuit_open');
    expect(node.actionStatus).toBe('locked');
    expectNoInternals(visibleText(node.error, node.summary, node));
  });

  it('reports a locked session as a typed denial with no fabricated action status', async () => {
    // Another operation of the same OWNER exhausted verification, so the breaker is tripped; this node
    // was never gated, so there is no persisted row for it and none may be invented.
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const task = await createTaskGraph(
      { sessionId, userId: DEMO_USER_ID, goal: 'Inspect balance', status: 'running' },
      [{ nodeId: 'read', name: 'Read balance', kind: 'tool', tool: 'get_balance', args: {}, status: 'running' }],
    );

    const outcome = await executeGatedTool({
      sessionId, userId: DEMO_USER_ID, toolName: 'get_balance', args: {},
      userRequest: 'Inspect balance', taskId: task.id, nodeId: 'read',
    } as GatewayContext);

    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.code).toBe('CIRCUIT_OPEN');
    expect(outcome.failure?.reason).toBe('circuit_open');
    expect(isLockedRefusal(outcome.failure)).toBe(true);
    expect(outcome.actionStatus, 'no persisted row means no action status').toBeUndefined();
    expect(outcome.pendingActionId).toBeUndefined();
    expectNoInternals(visibleText(outcome.error, outcome.summary, outcome));
  });

  it('preserves the exhausted-verification reason and locked status through the node projection', async () => {
    // The confirmation path is the ONE producer of `mfa_attempts_exhausted`; the port must be able to
    // hand that same typed refusal to the plan layer without flattening it to a bare code.
    const parked = await parkRedTransferPlan();
    const attempts = await exhaustMfaAttempts(parked.actionId, parked.sessionId);
    const terminal = attempts[attempts.length - 1]!;
    expect(terminal.status).toBe('locked');
    expect(terminal.failure?.reason).toBe('mfa_attempts_exhausted');
    expect(terminal.failure?.code).toBe('MFA_LOCKED');

    const failure = toPlanFailure(terminal.failure);
    expect(failure).toMatchObject({ code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', attemptsLeft: 0 });
    const node = settleToolNode(
      nodeSpec(parked),
      { ok: false, requiresConfirmation: true, pendingActionId: parked.actionId, failure, actionStatus: terminal.status },
      1,
      2,
    );
    expect(node.failure).toEqual(failure);
    expect(node.actionStatus).toBe('locked');
    expectNoInternals(visibleText(node.error, node.summary, node));
  });
});

describe('plan tool port: a settled row is not an authorization', () => {
  it('re-authorizes an explicit user retry of a failed write with a new pending action', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const task = await createTaskGraph(
      { sessionId, userId: DEMO_USER_ID, goal: 'Pay 张伟', status: 'running' },
      [{ nodeId: 'pay', name: 'Pay', kind: 'tool', tool: 'transfer_money', args: { name: CONTACTS[0].name, amount: '200.00' }, status: 'running' }],
    );
    const context = {
      sessionId, userId: DEMO_USER_ID, toolName: 'transfer_money',
      args: { name: CONTACTS[0].name, amount: '200.00' },
      userRequest: `给${CONTACTS[0].name}转账200元`, taskId: task.id, nodeId: 'pay',
    } as GatewayContext;

    const parked = await executeGatedTool(context);
    expect(parked.requiresConfirmation).toBe(true);
    // The bank refuses the write (no funds), so the operation settles as a FAILED command.
    await getTestPrisma().account.updateMany({ where: { userId: DEMO_USER_ID }, data: { balanceMinor: 0n } });
    expect((await confirmAction(parked.pendingActionId!)).ok).toBe(false);
    const original = await getTestPrisma().toolInvocation.findFirstOrThrow({ where: { taskId: task.id } });
    expect(original.status).toBe('failed');

    const retried = await retryTask(sessionId, task.id);
    expect(retried.status).toBe('waiting_confirmation');

    const record = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: original.id } });
    expect(record.operationKey).toBe(original.operationKey);
    expect(record.attempt).toBe(2);
    expect(await getTestPrisma().toolInvocation.count({ where: { taskId: task.id } })).toBe(1);
    const pending = await getTestPrisma().pendingAction.findMany({ where: { taskId: task.id, status: 'pending' } });
    expect(pending, 'a failed row must not stand in for a fresh authorization').toHaveLength(1);
    expect(pending[0]!.id).not.toBe(parked.pendingActionId);
    expect(pending[0]!.invocationId).toBe(original.id);
    expect(await getTestPrisma().executionReceipt.count({ where: { key: original.operationKey } })).toBe(0);
  });

  it('does not mint a second action while the node still awaits its decision', async () => {
    const parked = await parkRedTransferPlan();
    const outcome = await executeGatedTool(await portContext(parked, '5000'));
    expect(outcome.ok).toBe(false);
    expect(outcome.requiresConfirmation).toBe(true);
    expect(outcome.pendingActionId).toBe(parked.actionId);
    const rows = await getTestPrisma().pendingAction.findMany({ where: { taskId: parked.taskId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(parked.actionId);
  });
});
