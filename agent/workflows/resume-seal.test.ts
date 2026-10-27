/**
 * `resume-seal.test.ts` — the SEAL contract of a plan whose parked decision already SETTLED,
 * exercised against a REAL SQLite database.
 *
 * The unit spec (`parked-actions.test.ts`) pins the reader and the wiring with stubbed ports; this
 * spec proves the same contract end to end, on real `AgentTask`/`AgentTaskNode`/`PendingAction` rows:
 *
 *  - `resumeTask` SEALS a node parked on a TERMINAL action: the node is recorded with the status that
 *    decision PROJECTS — `success` for an operation the server really `executed` (with NO sentence),
 *    `failed` with the catalog sentence for a lock or an unknown outcome — its dead `pendingActionId`
 *    is dropped, the node is never driven (the tool port is not reached) and the plan is returned
 *    normally: no exception, no resurrection of the settled decision, no new `PendingAction`, no new
 *    `SecurityEvent`/audit row, the settled row untouched.
 *  - the seal is LOCAL to the settled node: an order-only successor keeps advancing, and a plan whose
 *    every node is already terminal simply reports that there is nothing left to advance.
 *  - `retryTask` stays a STRUCTURED refusal (`MFA_LOCKED` for a lock, `CONFLICT` for an unknown
 *    outcome) taken BEFORE any claim, so no tool runs and no row is written.
 *  - nothing on either path leaks an internal marker (`__SECURITY_BLOCK__`, a `decisionKind`, a
 *    stringified object or a stack frame) through a thrown message or the returned plan snapshot.
 */
import { describe, expect, it } from 'vitest';

import { executeGatedTool, readPendingActionId } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import { claimPendingAction } from '@/lib/db/repositories/pendingAction';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
import { AppError } from '@/lib/errors';
import { DEFAULT_LOCALE, createTranslator } from '@/lib/i18n/shared';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import {
  auditLogCount,
  demoSessionId,
  lockAction,
  parkConfirmOnlyTransfer,
  parkRedTransferPlan,
  pendingActionRow,
  securityEventsOfKind,
  type ParkedPlanAction,
} from '@/tests/helpers/locked-action';
import { resumeTask, retryTask } from './controls';
import type { TaskRunTool } from './contracts';

useFreshDatabase();

const t = createTranslator(DEFAULT_LOCALE);

/** The shipped `chat.error.actionLocked` sentence a sealed `locked` node records as its `error`. */
const LOCKED_SENTENCE = '该操作已锁定，无法继续验证或执行。原因：验证码错误次数已达上限。请在安全中心解除限制后重新发起操作。';

/* ------------------------------------------------------------------------------------ fixtures */

/** Seeded contact 张伟 — resolves unambiguously, and the only recipient these plans name. */
const RECIPIENT = '张伟';
/** Transfer above the ¥1,000 confirmation-only limit ⇒ RED ⇒ the gateway parks `awaiting_mfa`. */
const RED_AMOUNT = '5000';
/** Transfer below the limit ⇒ YELLOW ⇒ the gateway parks `pending` (confirmation only). */
const CONFIRM_ONLY_AMOUNT = '500';
/** The node the seeded single-node plans park on. */
const NODE_ID = 'n1';
/** The order-only successor of a sealed node in the two-node plan. */
const NEXT_NODE_ID = 'n2';

/** Internal gateway markers that must never surface through a control path's own texts. */
const INTERNAL_MARKERS = ['__SECURITY_BLOCK__', 'decisionKind', '[object Object]'];
/** A raw stack frame is an internal-error leak too. */
const STACK_FRAME = /\n\s+at\s/;

/** The statuses a sealed decision must never be "resumed" back to. */
const ACTIONABLE_STATUSES = ['pending', 'awaiting_mfa'] as const;

/* --------------------------------------------------------------------------------------- ports */

/**
 * The gateway-authorized per-node runner used to SEED a plan. It forwards the node identity
 * (`ctx.taskId`/`ctx.nodeId`), which is what scopes a parked action to its plan node.
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

interface RecordedRunTool {
  runTool: TaskRunTool;
  /** Every node the executor asked a tool for, in order. */
  driven: string[];
}

/**
 * A RECORDING tool port: `allowed` names the tools this resume may legitimately drive. Any other
 * call is a contract violation, so it fails loudly instead of quietly re-executing a settled write.
 */
function recordingRunTool(
  sessionId: string,
  userRequest: string,
  allowed: readonly string[],
): RecordedRunTool {
  const driven: string[] = [];
  const runTool: TaskRunTool = async (toolName, args, ctx) => {
    driven.push(ctx.nodeId);
    if (!allowed.includes(toolName)) {
      throw new Error(`the settled node was re-driven through '${toolName}' (node ${ctx.nodeId})`);
    }
    return executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: toolName as ToolName,
      args,
      userRequest,
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });
  };
  return { runTool, driven };
}

/* -------------------------------------------------------------------------------------- probes */

function assertNoInternalMarkers(text: string, label: string): void {
  for (const marker of INTERNAL_MARKERS) {
    expect(text.includes(marker), `${label} leaked the internal marker ${marker}: ${text}`).toBe(false);
  }
  expect(STACK_FRAME.test(text), `${label} leaked a raw stack frame: ${text}`).toBe(false);
}

/** Every `PendingAction` of a plan — the "no new row, no reopened decision" probe. */
function actionsOfTask(taskId: string) {
  return getTestPrisma().pendingAction.findMany({
    where: { taskId },
    select: { id: true, status: true, updatedAt: true },
    orderBy: { id: 'asc' },
  });
}

/** The node a returned snapshot records for `nodeId`, failing loudly when it disappeared. */
function nodeOf(plan: TaskPlan, nodeId: string) {
  const node = plan.results.find(result => result.id === nodeId);
  if (node === undefined) throw new Error(`the returned plan ${plan.id} lost node '${nodeId}'`);
  return node;
}

/** Capture a thrown control error as text instead of failing the test with the raw throw. */
async function captureFailure(run: () => Promise<unknown>): Promise<{ thrown?: string }> {
  try {
    await run();
    return {};
  } catch (error) {
    return { thrown: `${AppError.from(error).message} :: ${String(error)}` };
  }
}

/**
 * Settle the parked action to the status the SERVER persists once the operation really landed — the
 * precondition of the "a committed write must not be sealed as a failure" spec.
 */
async function markActionExecuted(parked: ParkedPlanAction): Promise<void> {
  expect(await claimPendingAction({ actionId: parked.actionId, from: [...ACTIONABLE_STATUSES], to: 'executed' })).toBe(true);
  expect((await pendingActionRow(parked.actionId))!.status, 'the action must be settled executed').toBe('executed');
}

/**
 * Seed a two-node plan whose FIRST node parks on a RED transfer and whose SECOND node is an
 * order-only successor (`after`) reading the balance. The DB row of the parked action is CAS-ed to
 * `locked` — exactly the terminal status `security/security-gateway.ts#persistLockedAction` writes —
 * WITHOUT exhausting the owner-scoped breaker, so the successor node can still be driven and the
 * spec can observe that a seal is LOCAL to the settled node.
 */
async function seedTwoNodePlan(): Promise<ParkedPlanAction & { nextNodeId: string }> {
  const sessionId = await demoSessionId();
  const goal = `先给${RECIPIENT}转${RED_AMOUNT}元，再查一次余额`;
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    {
      goal,
      nodes: [
        {
          id: NODE_ID,
          name: `给${RECIPIENT}转账`,
          dependencies: [],
          kind: 'tool',
          tool: 'transfer_money',
          args: { name: RECIPIENT, amount: RED_AMOUNT },
        },
        {
          id: NEXT_NODE_ID,
          name: '查询余额',
          after: [NODE_ID],
          dependencies: [],
          kind: 'tool',
          tool: 'get_balance',
          args: {},
        },
      ],
    },
    { sessionId, runTool: gatewayRunTool(sessionId, goal) },
  );
  expect(result.ok, `runSubmitPlan rejected the two-node plan: ${result.error}`).toBe(true);
  const plan = result.data as TaskPlan;
  expect(plan.status, 'the RED transfer must park the plan').toBe('waiting_confirmation');
  const actionId = readPendingActionId(nodeOf(plan, NODE_ID).output);
  expect(typeof actionId, 'the RED transfer node parked no PendingAction').toBe('string');
  expect((await pendingActionRow(actionId!))?.status, 'a RED transfer must park in awaiting_mfa').toBe('awaiting_mfa');
  // The successor never ran: an order-only successor waits for its predecessor to become terminal.
  expect(nodeOf(plan, NEXT_NODE_ID).status).toBe('pending');
  expect(await claimPendingAction({ actionId: actionId!, from: ['awaiting_mfa', 'pending'], to: 'locked' })).toBe(true);
  return { sessionId, taskId: plan.id, nodeId: NODE_ID, actionId: actionId!, nextNodeId: NEXT_NODE_ID };
}

/* ---------------------------------------------------------------------------------------- spec */

describe('resuming a plan whose parked decision already settled SEALS that node', () => {
  it('seals the locked node without driving it, without touching the decision and without creating evidence', async () => {
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);

    const row = await pendingActionRow(parked.actionId);
    const before = {
      updatedAt: row!.updatedAt.getTime(),
      actions: (await actionsOfTask(parked.taskId)).map(action => ({ id: action.id, status: action.status })),
      audit: await auditLogCount(parked.sessionId),
      security: (await securityEventsOfKind(parked.sessionId, 'locked')).length,
    };

    const { runTool, driven } = recordingRunTool(parked.sessionId, '继续之前的转账', []);
    const resumed = await resumeTask(parked.sessionId, parked.taskId, { runTool });

    // The plan is returned NORMALLY — a settled decision is no longer a refusal.
    expect(resumed.id).toBe(parked.taskId);
    const sealed = nodeOf(resumed, parked.nodeId);
    expect(sealed.status).toBe('failed');
    expect(readPendingActionId(sealed.output)).toBeUndefined();
    // SEALED means NOT DRIVEN: the tool port is never reached for the settled node.
    expect(driven).toEqual([]);

    // The recorded justification is the SHIPPED catalog sentence, never a status literal or an id.
    expect(sealed.error).toBe(t('chat.error.actionLocked'));
    expect(sealed.error).toBe(LOCKED_SENTENCE);
    expect(sealed.error).not.toContain('locked');
    expect(sealed.error).not.toContain(parked.actionId);

    // A locked decision is a FAILURE of the plan — it is never reported as a completed step.
    expect(resumed.status).toBe('failed');

    // The decision itself is a TERMINAL fact: not re-opened, not duplicated, not rewritten.
    const after = await actionsOfTask(parked.taskId);
    expect(after.map(action => ({ id: action.id, status: action.status }))).toEqual(before.actions);
    for (const action of after) {
      expect(ACTIONABLE_STATUSES, 'a sealed decision reopened an executable action').not.toContain(action.status);
    }
    const stored = await pendingActionRow(parked.actionId);
    expect(stored!.status).toBe('locked');
    expect(stored!.updatedAt.getTime(), 'the seal rewrote the settled decision row').toBe(before.updatedAt);

    // Sealing a NODE records no security or audit evidence: nothing was authorized or attempted.
    expect(await auditLogCount(parked.sessionId)).toBe(before.audit);
    expect((await securityEventsOfKind(parked.sessionId, 'locked')).length).toBe(before.security);

    assertNoInternalMarkers(JSON.stringify(resumed), 'resumed plan snapshot');
  });

  it('records a settled EXECUTED node as COMPLETED — plan success, no sentence, no re-run', async () => {
    const parked = await parkConfirmOnlyTransfer(CONFIRM_ONLY_AMOUNT);
    await markActionExecuted(parked);
    const before = await pendingActionRow(parked.actionId);

    const { runTool, driven } = recordingRunTool(parked.sessionId, '继续之前的转账', []);
    const resumed = await resumeTask(parked.sessionId, parked.taskId, { runTool });

    // The write really landed, so the node COMPLETES and the plan settles `success`: the task card can
    // no longer show a failed plan for an operation whose limit/transfer already succeeded.
    const sealed = nodeOf(resumed, parked.nodeId);
    expect(sealed.status).toBe('success');
    expect(sealed.error).toBeUndefined();
    expect(readPendingActionId(sealed.output)).toBeUndefined();
    expect(resumed.status).toBe('success');

    // Not driven, not re-executed: the settled operation is evidence, never a re-run.
    expect(driven).toEqual([]);

    // The settled row is untouched and no duplicate/executable action was minted.
    const after = await actionsOfTask(parked.taskId);
    expect(after.map(action => ({ id: action.id, status: action.status }))).toEqual([
      { id: parked.actionId, status: 'executed' },
    ]);
    for (const action of after) {
      expect(ACTIONABLE_STATUSES, 'a sealed decision reopened an executable action').not.toContain(action.status);
    }
    expect((await pendingActionRow(parked.actionId))!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());

    assertNoInternalMarkers(JSON.stringify(resumed), 'completed-seal plan snapshot');
  });

  it('records an UNKNOWN OUTCOME as failed with the unknown-outcome sentence', async () => {
    const parked = await parkConfirmOnlyTransfer(CONFIRM_ONLY_AMOUNT);
    expect(await claimPendingAction({
      actionId: parked.actionId,
      from: [...ACTIONABLE_STATUSES],
      to: 'needs_reconciliation',
    })).toBe(true);

    const { runTool, driven } = recordingRunTool(parked.sessionId, '继续之前的转账', []);
    const resumed = await resumeTask(parked.sessionId, parked.taskId, { runTool });

    // An unknown outcome claims NEITHER success NOR a failed business effect: it stays failed, with
    // the manual-reconciliation sentence, and the plan does not claim a completed step.
    const sealed = nodeOf(resumed, parked.nodeId);
    expect(sealed.status).toBe('failed');
    expect(sealed.error).toBe(t('chat.error.unknownOutcome'));
    expect(readPendingActionId(sealed.output)).toBeUndefined();
    expect(resumed.status).toBe('failed');
    expect(driven).toEqual([]);
    expect((await pendingActionRow(parked.actionId))!.status).toBe('needs_reconciliation');

    assertNoInternalMarkers(JSON.stringify(resumed), 'unknown-outcome plan snapshot');
  });

  it('seals only the settled node — its successor still advances through the gateway', async () => {
    const parked = await seedTwoNodePlan();
    const { runTool, driven } = recordingRunTool(parked.sessionId, '先转账再查余额', ['get_balance']);

    const resumed = await resumeTask(parked.sessionId, parked.taskId, { runTool });

    const sealed = nodeOf(resumed, parked.nodeId);
    expect(sealed.status).toBe('failed');
    expect(readPendingActionId(sealed.output)).toBeUndefined();
    expect(sealed.error).toBe(LOCKED_SENTENCE);

    // The successor is NOT blocked by the seal: it is driven, once, and only it.
    const advanced = nodeOf(resumed, parked.nextNodeId);
    expect(advanced.status).toBe('success');
    expect(driven).toEqual([parked.nextNodeId]);

    // Still exactly ONE action for the plan, still locked, and never an executable duplicate.
    const actions = await actionsOfTask(parked.taskId);
    expect(actions.map(action => action.id)).toEqual([parked.actionId]);
    expect(actions[0].status).toBe('locked');

    assertNoInternalMarkers(JSON.stringify(resumed), 'advanced plan snapshot');
  });

  it('returns normally with nothing left to advance once every node is terminal', async () => {
    const parked = await seedTwoNodePlan();
    const first = recordingRunTool(parked.sessionId, '先转账再查余额', ['get_balance']);
    const afterSeal = await resumeTask(parked.sessionId, parked.taskId, { runTool: first.runTool });
    // Both nodes settled by now (the sealed one `failed`, its successor `success`).
    for (const node of afterSeal.results) {
      expect(['success', 'failed', 'skipped', 'cancelled'], `node ${node.id} is not terminal`).toContain(node.status);
    }

    const second = recordingRunTool(parked.sessionId, '再次继续', []);
    const resumed = await resumeTask(parked.sessionId, parked.taskId, { runTool: second.runTool });

    // A fully settled plan is a NORMAL return: no throw, no node driven, no node left runnable.
    expect(resumed.id).toBe(parked.taskId);
    expect(second.driven).toEqual([]);
    expect(resumed.results.map(node => node.status)).not.toContain('pending');
    expect(resumed.results.map(node => node.status)).not.toContain('running');
    expect(['success', 'failed']).toContain(resumed.status);
    expect(readPendingActionId(nodeOf(resumed, parked.nodeId).output)).toBeUndefined();

    assertNoInternalMarkers(JSON.stringify(resumed), 'settled plan snapshot');
  });

  it('keeps an explicit retry a structured refusal for a lock and for an unknown outcome', async () => {
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);
    const before = (await actionsOfTask(parked.taskId)).map(action => action.id);

    const locked = recordingRunTool(parked.sessionId, '重试之前的转账', []);
    await expect(retryTask(parked.sessionId, parked.taskId, { runTool: locked.runTool }))
      .rejects.toMatchObject({ code: 'MFA_LOCKED' });
    expect(locked.driven).toEqual([]);
    expect((await actionsOfTask(parked.taskId)).map(action => action.id)).toEqual(before);
    expect((await pendingActionRow(parked.actionId))!.status).toBe('locked');

    // An unknown outcome is a CONFLICT, not a lock and not a silent success.
    await getTestPrisma().pendingAction.update({
      where: { id: parked.actionId },
      data: { status: 'needs_reconciliation' },
    });
    const unknown = recordingRunTool(parked.sessionId, '重试之前的转账', []);
    await expect(retryTask(parked.sessionId, parked.taskId, { runTool: unknown.runTool }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(unknown.driven).toEqual([]);
    expect((await actionsOfTask(parked.taskId)).map(action => action.id)).toEqual(before);
    expect((await pendingActionRow(parked.actionId))!.status).toBe('needs_reconciliation');
  });

  it('keeps an explicit retry of an EXECUTED action a structured refusal', async () => {
    const parked = await parkConfirmOnlyTransfer(CONFIRM_ONLY_AMOUNT);
    await markActionExecuted(parked);
    const before = (await actionsOfTask(parked.taskId)).map(action => ({ id: action.id, status: action.status }));

    // A completed operation is still NEVER re-driven by a retry: the node is not reset, no new action
    // is minted and the tool never runs again.
    const retried = recordingRunTool(parked.sessionId, '重试之前的转账', []);
    await expect(retryTask(parked.sessionId, parked.taskId, { runTool: retried.runTool }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: t('chat.error.stateChanged') });
    expect(retried.driven).toEqual([]);
    expect((await actionsOfTask(parked.taskId)).map(action => ({ id: action.id, status: action.status })))
      .toEqual(before);
  });

  it('surfaces no internal marker through a control path error or a returned plan', async () => {
    const parked = await parkRedTransferPlan();
    await lockAction(parked.actionId, parked.sessionId);

    const resume = recordingRunTool(parked.sessionId, '继续之前的转账', []);
    const resumed = await resumeTask(parked.sessionId, parked.taskId, { runTool: resume.runTool });
    const retry = recordingRunTool(parked.sessionId, '重试之前的转账', []);
    const failure = await captureFailure(async () =>
      retryTask(parked.sessionId, parked.taskId, { runTool: retry.runTool }));

    assertNoInternalMarkers(failure.thrown ?? '', 'retry refusal');
    assertNoInternalMarkers(JSON.stringify(resumed), 'resumed plan snapshot');
    assertNoInternalMarkers(JSON.stringify(resumed.results), 'resumed node results');
  });
});
