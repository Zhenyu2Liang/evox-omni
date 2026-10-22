/**
 * `parked-actions.test.ts` — the TERMINAL-state contract over a plan's parked human decisions.
 *
 * One reader, two consumers, pinned here against the PERSISTED `PendingAction` status:
 *  - `sealedParkedNodes` / `parkedActionIds` (READ-ONLY) — an OPEN (`pending` / `awaiting_mfa`)
 *    action, an ABSENT row and a `confirmed` row keep today's behavior (`confirmed` is neither open
 *    nor terminal — an authorized continuation in flight); a TERMINAL action — `locked` above all —
 *    is reported as SEALED with the plan layer's reason and a catalog sentence;
 *  - `resumeTask` SEALS such a node: it records the node `failed` with catalog text, drops the dead
 *    `pendingActionId` and lets the rest of the plan advance — the node is never driven, never
 *    surfaced as a pending decision, and the plan is returned normally (no exception);
 *  - `retryTask` REFUSES with a STRUCTURED `AppError`, no plan/node status is claimed (so the
 *    persisted plan status never flips to `running`) and no tool runs;
 *  - the refusal's public `message` is catalog business text, never a status literal, an id or a
 *    security payload, while the implementation facts stay in `detail` (internal only).
 *
 * Pure unit spec: the action/task repositories, the ownership reader and the plan port assembly are
 * stubbed (the plan ports are an in-memory snapshot), so this file touches no database and no
 * banking tool.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  getPendingActionOwnership: vi.fn(),
  updatePendingActionStatus: vi.fn(),
  claimPendingAction: vi.fn(),
  createPendingAction: vi.fn(),
  loadOwnedTask: vi.fn(),
  getTaskPlan: vi.fn(),
  claimTaskStatus: vi.fn(),
  claimTaskExecution: vi.fn(),
  releaseTaskExecution: vi.fn(),
  assertNoOpenManualReview: vi.fn(),
  clearStaleNodeClaims: vi.fn(),
  sweepCancelledPlan: vi.fn(),
  settlePlanFromNodes: vi.fn(),
  buildPlanDeps: vi.fn(),
  persistPlan: vi.fn(),
  persistNode: vi.fn(),
}));

vi.mock('@/lib/db/repositories/pendingAction', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/db/repositories/pendingAction')>()),
  getPendingActionOwnership: fakes.getPendingActionOwnership,
  // Every write path of a `PendingAction` row: the seal/refusal paths must leave ALL of them untouched.
  updatePendingActionStatus: fakes.updatePendingActionStatus,
  claimPendingAction: fakes.claimPendingAction,
  createPendingAction: fakes.createPendingAction,
}));
vi.mock('@/lib/db/repositories/task', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/db/repositories/task')>()),
  claimTaskStatus: fakes.claimTaskStatus,
  claimTaskExecution: fakes.claimTaskExecution,
  releaseTaskExecution: fakes.releaseTaskExecution,
}));
vi.mock('@/lib/db/repositories/manualReview', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/db/repositories/manualReview')>()),
  assertNoOpenManualReview: fakes.assertNoOpenManualReview,
}));
vi.mock('./ownership', async importOriginal => ({
  ...(await importOriginal<typeof import('./ownership')>()),
  loadOwnedTask: fakes.loadOwnedTask,
  getTaskPlan: fakes.getTaskPlan,
}));
// The plan port assembly is the ONE seam the control path writes through: replacing it keeps the
// `persistNode`/`persistPlan` writes observable without a database or an executor lease.
vi.mock('./ports', async importOriginal => ({
  ...(await importOriginal<typeof import('./ports')>()),
  buildPlanDeps: fakes.buildPlanDeps,
}));
vi.mock('./claims', async importOriginal => ({
  ...(await importOriginal<typeof import('./claims')>()),
  clearStaleNodeClaims: fakes.clearStaleNodeClaims,
}));
vi.mock('./cancellation', async importOriginal => ({
  ...(await importOriginal<typeof import('./cancellation')>()),
  sweepCancelledPlan: fakes.sweepCancelledPlan,
}));
vi.mock('../task-fencing', async importOriginal => ({
  ...(await importOriginal<typeof import('../task-fencing')>()),
  settlePlanFromNodes: fakes.settlePlanFromNodes,
}));

import { assertParkedActionsNotTerminal, parkedActionIds, sealedParkedNodes } from './parked-actions';
import { resumeTask, retryTask } from './controls';
import { readPendingActionId, type TaskControlDeps } from './contracts';
import type { PlanDeps, PlanFailure, PlanNodeResult } from '@/planner';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, createTranslator } from '@/lib/i18n/shared';
import type { AgentTaskWithNodes } from '@/lib/db/repositories/task';
import type { TaskNodeResult, TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';

const t = createTranslator(DEFAULT_LOCALE);

const SESSION = 'sess_parked';
const TASK = 'task_parked';
const USER = 'user_parked';
const ACTION = 'action_parked';

/** The shipped `chat.error.actionLocked` sentence a sealed `locked` node records as its `error`. */
const LOCKED_SENTENCE = '该操作已锁定，无法继续验证或执行。原因：验证码错误次数已达上限。请在安全中心解除限制后重新发起操作。';

/** A tool runner that proves a sealed node never reaches the tool port. */
const runTool = vi.fn(async () => {
  throw new Error('no banking tool may run for a settled parked decision');
}) as unknown as TaskControlDeps['runTool'];

/* ---------------------------------------------------------------------------------- fixtures */

function node(id: string, status: TaskNodeStatus, pendingActionId?: string, failure?: PlanFailure): PlanNodeResult {
  return {
    id,
    name: id,
    status,
    ...(pendingActionId === undefined ? {} : { output: { pendingActionId } }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function plan(results: TaskNodeResult[], status: TaskPlan['status'] = 'waiting_confirmation'): TaskPlan {
  return {
    id: TASK,
    sessionId: SESSION,
    goal: '先查余额再给张伟转200元',
    status,
    nodes: results.map(result => ({ id: result.id, name: result.name, dependencies: [], kind: 'note' })),
    results,
    createdAt: 0,
    generation: 1,
    updatedAt: 0,
  };
}

/**
 * A persisted task row carrying ONE parked node. Cast because the control path only reads
 * `id/sessionId/goal/status/generation/nodes` through `toTaskPlan`; the remaining columns are
 * irrelevant to this fence.
 */
function taskRow(parkedActionId = ACTION): AgentTaskWithNodes {
  return {
    id: TASK,
    sessionId: SESSION,
    userId: USER,
    goal: '先查余额再给张伟转200元',
    status: 'waiting_confirmation',
    generation: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    nodes: [
      {
        id: 'n1',
        taskId: TASK,
        nodeId: 'n1',
        name: 'n1',
        kind: 'note',
        order: 0,
        status: 'waiting_confirmation',
        output: JSON.stringify({ pendingActionId: parkedActionId }),
      },
    ],
  } as unknown as AgentTaskWithNodes;
}

/** An ownership projection for the parked action in the given persisted status. */
function actionOwnership(status: string) {
  return { id: ACTION, userId: USER, sessionId: SESSION, status };
}

/**
 * The in-memory node store the stubbed plan ports write to and `getTaskPlan` reads back, so the
 * snapshot `resumeTask` returns reflects exactly what the seal persisted.
 */
const stored = new Map<string, TaskNodeResult>();
/** Last plan status the stubbed `persistPlan` port wrote (the plan-level half of the seal). */
let storedPlanStatus: TaskPlan['status'] | undefined;

function seedStore(results: TaskNodeResult[]): void {
  stored.clear();
  for (const result of results) stored.set(result.id, result);
}

function fakePlanDeps(): PlanDeps {
  return {
    runTool: (toolName, args, context) => runTool(toolName, args, context),
    onNodeUpdate: () => {},
    persistPlan: fakes.persistPlan,
    persistNode: fakes.persistNode,
    controls: { pollControls: () => [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storedPlanStatus = undefined;
  seedStore([node('n1', 'waiting_confirmation', ACTION)]);

  fakes.assertNoOpenManualReview.mockResolvedValue(undefined);
  fakes.loadOwnedTask.mockResolvedValue(taskRow());
  fakes.getTaskPlan.mockImplementation(async () => plan([...stored.values()], storedPlanStatus));
  fakes.claimTaskStatus.mockResolvedValue(true);
  fakes.claimTaskExecution.mockResolvedValue(true);
  fakes.releaseTaskExecution.mockResolvedValue(undefined);
  fakes.clearStaleNodeClaims.mockResolvedValue(undefined);
  fakes.sweepCancelledPlan.mockResolvedValue({ revoked: [], alreadySettled: [], failed: [] });
  fakes.settlePlanFromNodes.mockResolvedValue(false);
  fakes.persistPlan.mockImplementation(async (snapshot: TaskPlan) => {
    storedPlanStatus = snapshot.status;
  });
  fakes.persistNode.mockImplementation(async (_planId: string, result: TaskNodeResult) => {
    stored.set(result.id, result);
  });
  fakes.buildPlanDeps.mockImplementation(() => fakePlanDeps());
});

/* --------------------------------------------------------------------------- locating actions */

describe('parkedActionIds', () => {
  it('collects the action ids of PARKED nodes only, once each', () => {
    const ids = parkedActionIds(plan([
      node('settled', 'success', 'action_done'),
      node('confirm', 'waiting_confirmation', 'action_a'),
      node('verify', 'waiting_verification', 'action_b'),
      node('same', 'waiting_confirmation', 'action_a'),
      node('no-gate', 'waiting_confirmation'),
      node('pending', 'pending', 'action_c'),
    ]));
    expect(ids).toEqual(['action_a', 'action_b']);
  });
});

/* ------------------------------------------------------------------- the terminal-state fence */

describe('sealedParkedNodes', () => {
  it('seals nothing while the decision is OPEN, the row is gone or the action is still in flight', async () => {
    for (const ownership of [actionOwnership('pending'), actionOwnership('awaiting_mfa'), actionOwnership('confirmed'), null]) {
      fakes.getPendingActionOwnership.mockResolvedValue(ownership);
      await expect(sealedParkedNodes(plan([node('n1', 'waiting_confirmation', ACTION)]))).resolves.toEqual([]);
    }
  });

  it('reports every settled parked node with the plan reason and the catalog sentence — read-only', async () => {
    // The reason vocabulary is the plan layer's own (`@/planner` `SealReason`): every status that is
    // no longer OPEN is `action_not_open`, and a recorded LOCKED refusal is `locked_refusal`.
    const cases = [
      { status: 'locked', reason: 'action_not_open', error: t('chat.error.actionLocked') },
      { status: 'needs_reconciliation', reason: 'action_not_open', error: t('chat.error.unknownOutcome') },
      { status: 'executed', reason: 'action_not_open', error: t('chat.error.stateChanged') },
      { status: 'cancelled', reason: 'action_not_open', error: t('chat.error.stateChanged') },
    ] as const;
    for (const expected of cases) {
      fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership(expected.status));
      await expect(sealedParkedNodes(plan([node('n1', 'waiting_verification', ACTION)]))).resolves.toEqual([
        { nodeId: 'n1', actionId: ACTION, actionStatus: expected.status, reason: expected.reason, error: expected.error },
      ]);
    }
    // A recorded LOCKED refusal seals the node through the refusal itself, ahead of the status check.
    fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership('locked'));
    await expect(sealedParkedNodes(plan([
      node('n1', 'waiting_verification', ACTION, { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted' }),
    ]))).resolves.toEqual([
      { nodeId: 'n1', actionId: ACTION, actionStatus: 'locked', reason: 'locked_refusal', error: t('chat.error.actionLocked') },
    ]);
    // A read-only query: no status write, no claim, no execution.
    expect(fakes.updatePendingActionStatus).not.toHaveBeenCalled();
    expect(fakes.claimPendingAction).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe('assertParkedActionsNotTerminal', () => {
  it('resolves for an OPEN decision, an absent row and a confirmed (in-flight) action', async () => {
    for (const ownership of [actionOwnership('pending'), actionOwnership('awaiting_mfa'), actionOwnership('confirmed'), null]) {
      fakes.getPendingActionOwnership.mockResolvedValue(ownership);
      await expect(assertParkedActionsNotTerminal(plan([node('n1', 'waiting_confirmation', ACTION)]))).resolves.toBeUndefined();
    }
  });

  it('refuses a LOCKED action with MFA_LOCKED and catalog text — never the status literal or an id', async () => {
    fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership('locked'));

    const thrown = await assertParkedActionsNotTerminal(plan([node('n1', 'waiting_confirmation', ACTION)]))
      .then(() => undefined, (error: unknown) => error as { code?: string; message?: string; detail?: unknown });

    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe('MFA_LOCKED');
    expect(thrown!.message).toBe(t('chat.error.actionLocked'));
    expect(thrown!.message).not.toContain('locked');
    expect(thrown!.message).not.toContain(ACTION);
    expect(thrown!.message).not.toContain('__SECURITY_BLOCK__');
    // Implementation facts are diagnostics only, kept OUT of the user-visible message.
    expect(thrown!.detail).toEqual({ taskId: TASK, actionId: ACTION, status: 'locked' });
  });

  it('refuses an UNKNOWN OUTCOME and every other settled status with CONFLICT', async () => {
    fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership('needs_reconciliation'));
    await expect(assertParkedActionsNotTerminal(plan([node('n1', 'waiting_confirmation', ACTION)])))
      .rejects.toMatchObject({ code: 'CONFLICT', message: t('chat.error.unknownOutcome') });

    for (const status of ['executed', 'failed', 'cancelled']) {
      fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership(status));
      const error = await assertParkedActionsNotTerminal(plan([node('n1', 'waiting_verification', ACTION)]))
        .then(() => undefined, (thrown: unknown) => thrown as { code?: string; message?: string });
      expect(error!.code).toBe('CONFLICT');
      expect(error!.message).toBe(t('chat.error.stateChanged'));
      expect(error!.message).not.toContain(status);
    }
  });
});

/* ------------------------------------------------------------------------ resume / retry wiring */

describe('resume / retry of a plan parked on a settled decision', () => {
  it('SEALS the settled node on resume — recorded failed, action link dropped, never driven', async () => {
    fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership('locked'));

    // A settled parked decision is NO LONGER a refusal: resume returns the plan normally.
    const resumed = await resumeTask(SESSION, TASK, { runTool });
    expect(resumed.id).toBe(TASK);

    // The returned snapshot: the node is TERMINAL and holds no `pendingActionId`, so nothing can
    // re-read it as parked, and the plan itself settled instead of staying `waiting_confirmation`.
    const resumedNode = resumed.results.find(result => result.id === 'n1');
    expect(resumedNode?.status).toBe('failed');
    expect(readPendingActionId(resumedNode?.output)).toBeUndefined();
    expect(resumed.status).toBe('failed');

    // SEALED means NOT DRIVEN: the walk never reaches the tool port for this node.
    expect(runTool).not.toHaveBeenCalled();

    // The seal is ONE node write through the same leased run's node port.
    expect(fakes.persistNode).toHaveBeenCalledTimes(1);
    const [persistedPlanId, persistedNode] = fakes.persistNode.mock.calls[0] as [string, TaskNodeResult];
    expect(persistedPlanId).toBe(TASK);
    expect(persistedNode.id).toBe('n1');
    expect(persistedNode.status).toBe('failed');
    expect(persistedNode.output).toBeUndefined();
    expect(readPendingActionId(persistedNode.output)).toBeUndefined();
    // The recorded justification is the SPECIFIC catalog sentence, never a status literal or an id.
    expect(persistedNode.error).toBe(t('chat.error.actionLocked'));
    expect(persistedNode.error).toBe(LOCKED_SENTENCE);
    expect(persistedNode.error).not.toContain('locked');
    expect(persistedNode.error).not.toContain(ACTION);

    // The seal records a fact about the NODE: it never settles, re-opens or re-creates the decision.
    expect(fakes.updatePendingActionStatus).not.toHaveBeenCalled();
    expect(fakes.claimPendingAction).not.toHaveBeenCalled();
    expect(fakes.createPendingAction).not.toHaveBeenCalled();

    // The seal happens INSIDE the normal leased resume, and the lease is released again afterwards.
    expect(fakes.claimTaskStatus).toHaveBeenCalledTimes(1);
    expect(fakes.claimTaskExecution).toHaveBeenCalledTimes(1);
    expect(fakes.releaseTaskExecution).toHaveBeenCalledTimes(1);
  });

  it('refuses to retry a plan parked on a settled decision', async () => {
    fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership('executed'));

    await expect(retryTask(SESSION, TASK, { runTool })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(fakes.claimTaskStatus).not.toHaveBeenCalled();
    expect(fakes.claimTaskExecution).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });

  it('keeps today\'s behavior while the parked decision is still OPEN or its row is gone', async () => {
    for (const ownership of [actionOwnership('pending'), actionOwnership('awaiting_mfa'), null]) {
      vi.clearAllMocks();
      fakes.assertNoOpenManualReview.mockResolvedValue(undefined);
      fakes.loadOwnedTask.mockResolvedValue(taskRow());
      fakes.getTaskPlan.mockResolvedValue(plan([node('n1', 'waiting_confirmation', ACTION)]));
      // The claim loses the race ⇒ the control returns the current snapshot (no execution).
      fakes.claimTaskStatus.mockResolvedValue(false);
      fakes.getPendingActionOwnership.mockResolvedValue(ownership);

      await resumeTask(SESSION, TASK, { runTool });

      expect(fakes.claimTaskStatus).toHaveBeenCalledTimes(1);
      expect(fakes.claimTaskExecution).not.toHaveBeenCalled();
      expect(runTool).not.toHaveBeenCalled();
    }
  });
});

/* ------------------------------------------------------------------------------ catalog sanity */

it('resolves the refusal sentences from the shipped catalog', () => {
  expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  for (const key of ['chat.error.actionLocked', 'chat.error.stateChanged', 'chat.error.unknownOutcome'] as const) {
    expect(t(key)).not.toBe(key);
    expect(t(key)).not.toContain('{');
  }
});
