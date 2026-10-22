/**
 * TERMINAL-LOCK × RECOVERY REGRESSION.
 *
 * A `locked` `PendingAction` is a TERMINAL fact: the MFA attempt limit is exhausted, the security
 * gateway persisted the terminal status (`security/security-gateway.ts#persistLockedAction`) and the
 * `MfaChallenge` is locked too. Nothing a user does afterwards — refreshing, restarting the process,
 * recovering the interrupted run, resuming/retrying the owning task plan, or hitting the explicit
 * action-recovery entry point — may move that row back to `pending`/`awaiting_mfa` (which would
 * re-open the confirmation/MFA popup forever) or create a NEW actionable row for the same node.
 *
 * This spec drives the REAL recovery entry points, in-process, against a real SQLite database:
 *
 *  1. Durable run restart/recovery — `recoverOwnedRun` (`agent/durable/service.ts:103`). The run is
 *     seeded through the production `beginRun` admission + `AgentRunJournal`, its only invocation is
 *     parked `waiting_verification`, and the invocation's operation key is the `nxe:<task>:<node>`
 *     form so the run is genuinely LINKED to the locked action's task (`runPendingActionWhere`,
 *     `lib/db/repositories/agentRun.ts:215`). Recovery must take the AUTHORIZATION_REQUIRED
 *     early-return (`agent/durable/service.ts:159-162`) without touching the locked row.
 *
 *  2. Task-plan resume-or-retry — `resumeTask` (`agent/workflows/controls.ts:26`) then `retryTask`
 *     (`agent/workflows/controls.ts:44`) for the locked action's `taskId`, which RE-DRIVES the
 *     `waiting_verification` node through the gateway (`executeGatedTool` →
 *     `securityGateway#handleToolCall`), followed by the explicit action-recovery entry point
 *     `recoverAction` (`agent/index.ts:164`).
 *
 * Every recovery case funnels through ONE shared probe (`assertStillLocked`) so the fail-closed
 * invariants cannot drift apart: status + `updatedAt` unchanged, challenge still locked, NO new
 * `PendingAction`, NO new audit/security rows, NO money movement, and the action never becomes
 * surfaceable through the real `GET /api/actions` read model.
 *
 * The production code is already correct, so these assertions are expected to PASS. If one ever
 * goes RED it is a REAL resurrection bug — never weaken the assertion.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { readPendingActionId, recoverAction, retryTask, resumeTask } from '@/agent';
import { AgentRunJournal, beginRun } from '@/agent/durable';
import { runtimeRequestDigest } from '@/agent/durable/serialization';
import { recoverOwnedRun } from '@/agent/durable/service';
import { GET as actionsGet } from '@/app/api/actions/route';
import { AppError } from '@/lib/errors';
import { getJson } from '@/tests/app/harness';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  auditLogCount,
  checkingBalance,
  lockAction,
  mfaChallengesFor,
  parkRedTransferPlan,
  pendingActionRow,
  securityEventsOfKind,
  transactionsCount,
  zhangweiTransfers,
  type ParkedPlanAction,
} from '../helpers/locked-action';

/** Internal gateway markers that must NEVER surface through a recovery path's own error/message. */
const INTERNAL_MARKERS = ['__SECURITY_BLOCK__', 'decisionKind', '[object Object]'];
/** A raw stack frame is an internal-error leak too. */
const STACK_FRAME = /\n\s+at\s/;

/** The statuses a lock must never be "recovered" back to. */
const ACTIONABLE_STATUSES = ['pending', 'awaiting_mfa'];

/** Everything a recovery attempt must leave untouched — captured AFTER the lock is terminal. */
interface LockBaseline {
  updatedAt: number;
  /** Every `PendingAction` for the locked action's task (ids + count), so a NEW row is detectable. */
  actionIdsForTask: string[];
  challenges: Array<{ id: string; status: string }>;
  auditCount: number;
  mfaRequiredEvents: number;
  lockedEvents: number;
  balance: string;
  transactionCount: number;
  zhangweiCount: number;
}

/* ------------------------------------------------------------------------------------- probes */

function assertNoInternalMarkers(text: string, label: string): void {
  for (const marker of INTERNAL_MARKERS) {
    expect(text.includes(marker), `${label} leaked the internal marker ${marker}: ${text}`).toBe(false);
  }
  expect(STACK_FRAME.test(text), `${label} leaked a raw stack frame: ${text}`).toBe(false);
}

/** Baseline the durable facts of a terminally locked action. Call it right after `lockAction`. */
async function baselineLockedAction(parked: ParkedPlanAction): Promise<LockBaseline> {
  const row = await pendingActionRow(parked.actionId);
  if (row === null) throw new Error(`the locked action ${parked.actionId} has no PendingAction row`);
  const challenges = await mfaChallengesFor(parked.actionId);
  const actionsForTask = await getTestPrisma().pendingAction.findMany({
    where: { taskId: parked.taskId },
    select: { id: true },
  });
  return {
    updatedAt: row.updatedAt.getTime(),
    actionIdsForTask: actionsForTask.map(action => action.id).sort(),
    challenges: challenges.map(challenge => ({ id: challenge.id, status: challenge.status })),
    auditCount: await auditLogCount(parked.sessionId),
    mfaRequiredEvents: (await securityEventsOfKind(parked.sessionId, 'mfa_required')).length,
    lockedEvents: (await securityEventsOfKind(parked.sessionId, 'locked')).length,
    balance: await checkingBalance(),
    transactionCount: await transactionsCount(),
    zhangweiCount: (await zhangweiTransfers()).length,
  };
}

/**
 * THE shared invariant block: after ANY recovery attempt the action is still EXACTLY as locked as it
 * was, produced nothing new, moved no money, and is still not surfaced as an open decision.
 * `payloads` are the recovery path's own returned/emitted texts (messages, plan snapshots) — they
 * must not leak internal markers.
 */
async function assertStillLocked(
  parked: ParkedPlanAction,
  before: LockBaseline,
  payloads: ReadonlyArray<readonly [label: string, text: string]>,
): Promise<void> {
  const row = await pendingActionRow(parked.actionId);
  expect(row, `the locked action ${parked.actionId} disappeared during recovery`).not.toBeNull();
  expect(row!.status, 'recovery resurrected a terminally locked action').toBe('locked');
  expect(ACTIONABLE_STATUSES, 'a locked action must never be pending/awaiting_mfa again').not.toContain(row!.status);
  expect(row!.updatedAt.getTime(), 'recovery rewrote the locked action row').toBe(before.updatedAt);
  expect(row!.taskId, 'the locked action lost its plan link').toBe(parked.taskId);
  expect(row!.nodeId, 'the locked action lost its node link').toBe(parked.nodeId);
  expect(row!.sessionId).toBe(parked.sessionId);

  const challenges = await mfaChallengesFor(parked.actionId);
  expect(challenges.map(challenge => challenge.status), 'a recovery path reopened the locked challenge').toEqual(
    before.challenges.map(challenge => challenge.status),
  );
  expect(challenges.every(challenge => challenge.status === 'locked'), 'every challenge for a locked action stays locked').toBe(true);

  const actionsForTask = await getTestPrisma().pendingAction.findMany({
    where: { taskId: parked.taskId },
    select: { id: true },
  });
  expect(actionsForTask.map(action => action.id).sort(), 'recovery created a NEW PendingAction for the same task').toEqual(
    before.actionIdsForTask,
  );

  expect(await auditLogCount(parked.sessionId), 'a recovery path of a locked action wrote an audit row').toBe(before.auditCount);
  expect((await securityEventsOfKind(parked.sessionId, 'mfa_required')).length, 'recovery emitted a new mfa_required security event').toBe(
    before.mfaRequiredEvents,
  );
  expect((await securityEventsOfKind(parked.sessionId, 'locked')).length, 'recovery emitted a new locked security event').toBe(
    before.lockedEvents,
  );

  expect(await checkingBalance(), 'recovery of a locked action moved money').toBe(before.balance);
  expect(await transactionsCount(), 'recovery of a locked action wrote a ledger row').toBe(before.transactionCount);
  expect((await zhangweiTransfers()).length, 'recovery of a locked action paid 张伟').toBe(before.zhangweiCount);

  // The real read model the UI polls: a locked action is never an open/awaiting decision.
  const listed = await getJson(actionsGet, '/api/actions', { sessionId: parked.sessionId });
  expect(listed.status).toBe(200);
  expect(listed.ok).toBe(true);
  const surfaced = (listed.data as { data?: Array<{ id?: string; actionId?: string; status?: string }> } | null)?.data ?? [];
  const surfacedIds = surfaced.flatMap(entry => [entry.id, entry.actionId]).filter((id): id is string => typeof id === 'string');
  expect(surfacedIds, 'a locked action is still surfaced as an open decision').not.toContain(parked.actionId);
  expect(surfaced.map(entry => entry.status), 'a locked action was surfaced with a resumable status').not.toContain('locked');
  expect(surfaced.every(entry => entry.status !== 'locked')).toBe(true);

  for (const [label, text] of payloads) assertNoInternalMarkers(text, label);
}

/** Capture a thrown recovery error as reporting text instead of failing the test with a raw throw. */
async function captureFailure(run: () => Promise<unknown>): Promise<{ thrown: string | undefined }> {
  try {
    await run();
    return { thrown: undefined };
  } catch (error) {
    return { thrown: `${AppError.from(error).message} :: ${String(error)}` };
  }
}

/* --------------------------------------------------------------------------------------- spec */

describe('a terminally locked action is never resurrected by a recovery path', () => {
  beforeEach(resetDatabase);
  afterAll(disconnectTestPrisma);

  it('durable run restart/recovery leaves the locked action locked and only reports AUTHORIZATION_REQUIRED', async () => {
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);
    const before = await baselineLockedAction(parked);

    // A REAL admission through the production runtime: the run is linked to the locked action's
    // task via the `nxe:<task>:<node>` operation key (see `runPendingActionWhere`).
    const operationKey = `nxe:${parked.taskId}:${parked.nodeId}`;
    const args = { name: '张伟', amount: '5000' };
    const admitted = await beginRun({
      sessionId: parked.sessionId,
      userId: DEMO_USER_ID,
      requestId: 'locked-action-restart-recovery',
      request: { kind: 'input', message: '继续之前给张伟的转账' },
    });
    if (!admitted.lease) throw new Error('Missing run lease');
    const invocation = await getTestPrisma().toolInvocation.create({ data: {
      runId: admitted.run.id,
      ordinal: 0,
      callId: 'locked-action-waiting-call',
      toolName: 'transfer_money',
      argsJson: JSON.stringify(args),
      requestDigest: runtimeRequestDigest('transfer_money', args),
      operationKey,
      replaySafety: 'reconcile_only',
      status: 'waiting_verification',
      resultJson: JSON.stringify({ ok: false }),
    } });
    // A crash/restart boundary: the run is left parked waiting for the original authorization.
    await new AgentRunJournal(admitted.lease).finish('waiting_verification');

    const response = await recoverOwnedRun(admitted.run.id, { sessionId: parked.sessionId, userId: DEMO_USER_ID });

    // The recovery recognizes the still-required authorization instead of re-driving the write.
    expect(response.outcomes).toContainEqual({
      invocationId: invocation.id,
      action: 'waiting',
      reason: 'AUTHORIZATION_REQUIRED',
    });
    expect(response.outcomes.some(outcome => outcome.action === 'retried')).toBe(false);
    expect(response.message).toBe('The original confirmation or verification is still required.');
    expect(response.run.status, 'recovery must not settle a run whose authorization is still pending').toBe('waiting_verification');
    const storedRun = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
    expect(storedRun.leaseToken, 'the recovery must release the execution lease it acquired').toBeNull();

    await assertStillLocked(parked, before, [
      ['durable recovery message', response.message],
      ['durable recovery outcome', JSON.stringify(response.outcomes)],
    ]);
  });

  it('plan resume, plan retry and action recovery all leave the locked action locked and unsurfaced', async () => {
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);
    const before = await baselineLockedAction(parked);

    // Path 2a — RESUMING the owning plan re-drives the non-terminal `waiting_verification` node
    // through `executeGatedTool` → `securityGateway#handleToolCall`, which denies the locked session.
    const resumed = await resumeTask(parked.sessionId, parked.taskId);
    expect(resumed.id).toBe(parked.taskId);
    // The node must NOT be re-parked on a fresh/old action id: no actionable row was produced.
    expect(readPendingActionId(resumed.results.find(node => node.id === parked.nodeId)?.output)).toBeUndefined();
    await assertStillLocked(parked, before, [
      ['plan resume status', resumed.status],
      ['plan resume node status', String(resumed.results.find(node => node.id === parked.nodeId)?.status)],
    ]);

    // Path 2b — RETRYING the same plan re-walks it again; still no resurrection.
    const retried = await retryTask(parked.sessionId, parked.taskId);
    expect(retried.id).toBe(parked.taskId);
    expect(readPendingActionId(retried.results.find(node => node.id === parked.nodeId)?.output)).toBeUndefined();
    await assertStillLocked(parked, before, [
      ['plan retry status', retried.status],
      ['plan retry node status', String(retried.results.find(node => node.id === parked.nodeId)?.status)],
    ]);

    // Path 2c — the explicit action-recovery entry point declines without re-opening the decision
    // and without leaking an internal gateway marker into its message.
    const outcome = await recoverAction(parked.actionId, { sessionId: parked.sessionId });
    expect(outcome.ok, 'recovering a locked action must not fabricate a success').toBe(false);
    const outcomeStatus = (outcome as { status?: string }).status;
    if (outcomeStatus !== undefined) {
      expect(ACTIONABLE_STATUSES, 'action recovery re-opened the locked decision').not.toContain(outcomeStatus);
    }
    const outcomeMessage = (outcome as { message?: string }).message ?? '';
    expect(typeof outcomeMessage).toBe('string');
    await assertStillLocked(parked, before, [['action recovery message', outcomeMessage]]);
  });

  it('a blocked recovery attempt surfaces no internal marker through any thrown error', async () => {
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);
    const before = await baselineLockedAction(parked);

    // The plan is re-driven while the session breaker is open: whatever the recovery path does with
    // the opaque gateway deny, it must never throw it raw at the caller.
    const resumeFailure = await captureFailure(() => resumeTask(parked.sessionId, parked.taskId));
    const retryFailure = await captureFailure(() => retryTask(parked.sessionId, parked.taskId));
    const recoverFailure = await captureFailure(() => recoverAction(parked.actionId, { sessionId: parked.sessionId }));
    const thrown = [resumeFailure.thrown, retryFailure.thrown, recoverFailure.thrown].filter(
      (text): text is string => text !== undefined,
    );
    for (const text of thrown) assertNoInternalMarkers(text, 'recovery error');

    await assertStillLocked(parked, before, []);
  });
});
