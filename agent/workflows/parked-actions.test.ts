/**
 * `parked-actions.test.ts` — the TERMINAL-state fence over a plan's parked human decisions.
 *
 * Pins that resume/retry consult the PERSISTED `PendingAction` status BEFORE they claim anything:
 *  - an OPEN (`pending` / `awaiting_mfa`) action, an ABSENT row and a `confirmed` row keep today's
 *    behavior (`confirmed` is neither open nor terminal — an authorized continuation in flight);
 *  - a TERMINAL action — `locked` above all — is refused with a STRUCTURED `AppError`, no plan/node
 *    status is claimed (so the persisted plan status never flips to `running`) and no tool runs;
 *  - the refusal's public `message` is catalog business text, never a status literal, an id or a
 *    security payload, while the implementation facts stay in `detail` (internal only).
 *
 * Pure unit spec: the action/task repositories and the ownership reader are mocked, so this file
 * touches no database and no banking tool.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  getPendingActionOwnership: vi.fn(),
  loadOwnedTask: vi.fn(),
  getTaskPlan: vi.fn(),
  claimTaskStatus: vi.fn(),
  claimTaskExecution: vi.fn(),
  releaseTaskExecution: vi.fn(),
  assertNoOpenManualReview: vi.fn(),
}));

vi.mock('@/lib/db/repositories/pendingAction', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/db/repositories/pendingAction')>()),
  getPendingActionOwnership: fakes.getPendingActionOwnership,
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

import { assertParkedActionsNotTerminal, parkedActionIds } from './parked-actions';
import { resumeTask, retryTask } from './controls';
import type { TaskControlDeps } from './contracts';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, createTranslator } from '@/lib/i18n/shared';
import type { AgentTaskWithNodes } from '@/lib/db/repositories/task';
import type { TaskNodeResult, TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';

const t = createTranslator(DEFAULT_LOCALE);

const SESSION = 'sess_parked';
const TASK = 'task_parked';
const USER = 'user_parked';
const ACTION = 'action_parked';

/** A tool runner that proves the refusal happened BEFORE any execution was attempted. */
const runTool = vi.fn(async () => {
  throw new Error('no banking tool may run for a settled parked decision');
}) as unknown as TaskControlDeps['runTool'];

/* ---------------------------------------------------------------------------------- fixtures */

function node(id: string, status: TaskNodeStatus, pendingActionId?: string): TaskNodeResult {
  return {
    id,
    name: id,
    status,
    ...(pendingActionId === undefined ? {} : { output: { pendingActionId } }),
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

beforeEach(() => {
  vi.clearAllMocks();
  fakes.assertNoOpenManualReview.mockResolvedValue(undefined);
  fakes.loadOwnedTask.mockResolvedValue(taskRow());
  fakes.getTaskPlan.mockResolvedValue(plan([node('n1', 'waiting_confirmation', ACTION)]));
  fakes.claimTaskStatus.mockResolvedValue(false);
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
  it('refuses to resume BEFORE claiming any status, so the plan is left exactly as persisted', async () => {
    fakes.getPendingActionOwnership.mockResolvedValue(actionOwnership('locked'));

    await expect(resumeTask(SESSION, TASK, { runTool })).rejects.toMatchObject({ code: 'MFA_LOCKED' });

    expect(fakes.claimTaskStatus).not.toHaveBeenCalled();
    expect(fakes.claimTaskExecution).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
    // No snapshot rewrite either: the control short-circuits on the refusal.
    expect(fakes.releaseTaskExecution).not.toHaveBeenCalled();
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
