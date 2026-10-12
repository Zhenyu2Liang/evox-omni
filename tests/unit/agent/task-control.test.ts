/**
 * task-control.test.ts — the durable-DAG glue introduced for the `submit_plan` meta-tool:
 *
 *   (c) `agent/tools/planning.ts#runSubmitPlan` PERSISTS the plan (AgentTask + AgentTaskNode rows)
 *       with `plan.id === AgentTask.id`, so it survives a reload via the ownership-checked reader;
 *   (d) the public control glue (`getTaskPlan` / `pauseTask` / `resumeTask` / `cancelTask` /
 *       `retryTask`) enforces SERVER-SIDE ownership (`NOT_FOUND` / `SECURITY_DENIED`).
 *
 * Also pins the NODE-OUTPUT JSON SHAPE: a parked (gated) node records the human decision it waits
 * on inside `AgentTaskNode.output` as `{ pendingActionId }` — there is NO `pendingActionId` column.
 *
 * Offline + deterministic: the plan runs through the REAL gateway-authorized path
 * (`executeGatedTool`) against the real Banking SDK + test SQLite; only the model is the
 * `LLM_MODE=mock` faux provider (and it is never consulted here).
 *
 * Runs under the default config: `npm run test`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cancelTask,
  executeGatedTool,
  getOrCreateSession,
  getTaskPlan,
  pauseTask,
  readPendingActionId,
  resumeTask,
  retryTask,
} from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { TaskPlan } from '@/lib/contracts/task';
import { createTask, createTaskNode, getTask } from '@/lib/db/repositories/task';
import { safeParse } from '@/lib/json';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const GOAL = '先查余额再给张伟转200元';

/** A two-step DAG: a GREEN read, then a YELLOW transfer (which must PARK for a human decision). */
const PLAN_NODES = [
  { id: 'n1', name: '查询余额', dependencies: [], kind: 'tool', tool: 'get_balance', args: {} },
  {
    id: 'n2',
    name: '给张伟转账',
    dependencies: ['n1'],
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: '张伟', amount: 200 },
  },
];

/* ---------------------------------------------------------------------------------- helpers */

/** Create + persist a fresh AgentSession for the demo user and return its id. */
async function newPersistedSessionId(): Promise<string> {
  const snapshot = await getOrCreateSession(DEMO_USER_ID);
  return snapshot.sessionId;
}

/** The gateway-authorized per-node runner (never executes directly; a gated node parks). */
function sessionRunTool(sessionId: string) {
  return (toolName: string, args: Record<string, unknown>, ctx: { taskId: string; nodeId: string }) =>
    executeGatedTool({
      sessionId,
      ...ctx,
      userId: DEMO_USER_ID,
      toolName: toolName as Parameters<typeof executeGatedTool>[0]['toolName'],
      args,
      userRequest: GOAL,
    });
}

/** Persist a minimal task + one `note` node directly (no plan run) — for the control-path tests. */
async function seedTask(sessionId: string, goal = 'control probe'): Promise<string> {
  const task = await createTask({ sessionId, userId: DEMO_USER_ID, goal });
  await createTaskNode({
    taskId: task.id,
    nodeId: 'n1',
    name: '步骤',
    kind: 'note',
    order: 0,
    status: 'pending',
  });
  return task.id;
}

/** The persisted `AgentTask.status`. */
async function taskStatus(taskId: string): Promise<string> {
  const row = await getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
  return row!.status;
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ tests */

describe('runSubmitPlan persistence', () => {
  it('persists the AgentTask + ordered nodes so a parked plan survives a reload', async () => {
    const sessionId = await newPersistedSessionId();

    const result = await runSubmitPlan(
      DEMO_USER_ID,
      { goal: GOAL, nodes: PLAN_NODES },
      { sessionId, runTool: sessionRunTool(sessionId) },
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const plan = result.data as TaskPlan;
    // PLAN-ID ↔ AGENTTASK-ID: the returned plan id IS the durable row id.
    const row = await getTask(plan.id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(plan.id);
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.userId).toBe(DEMO_USER_ID);
    expect(row!.goal).toBe(GOAL);

    // Every node was persisted up-front, in declaration order, with its real spec.
    expect(row!.nodes.map((n) => n.nodeId)).toEqual(['n1', 'n2']);
    expect(row!.nodes.map((n) => n.order)).toEqual([0, 1]);
    expect(row!.nodes[0].tool).toBe('get_balance');
    expect(row!.nodes[1].tool).toBe('transfer_money');
    expect(await taskStatus(plan.id)).toBe('waiting_confirmation');

    // n1 (GREEN) executed; n2 (YELLOW) PARKED — the gate is durable, not in-memory.
    expect(row!.nodes[0].status).toBe('success');
    expect(row!.nodes[1].status).toBe('waiting_confirmation');
    const pendingActionId = readPendingActionId(safeParse(row!.nodes[1].output, undefined));
    expect(typeof pendingActionId).toBe('string');
    expect((pendingActionId ?? '').length).toBeGreaterThan(0);

    // The parked node really owns a PendingAction that was persisted at gate time.
    const parkedAction = await getTestPrisma().pendingAction.findUnique({
      where: { id: pendingActionId! },
    });
    expect(parkedAction).not.toBeNull();
    expect(parkedAction!.sessionId).toBe(sessionId);
    expect(parkedAction!.toolName).toBe('transfer_money');

    // "Refresh": reload through the public, ownership-checked reader — the plan is intact.
    const reloaded = await getTaskPlan(sessionId, plan.id);
    expect(reloaded.id).toBe(plan.id);
    expect(reloaded.sessionId).toBe(sessionId);
    expect(reloaded.goal).toBe(GOAL);
    expect(reloaded.status).toBe('waiting_confirmation');
    expect(reloaded.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(readPendingActionId(reloaded.results[1].output)).toBe(pendingActionId);
  });

  it('rejects a malformed plan without persisting a task row', async () => {
    const sessionId = await newPersistedSessionId();

    const result = await runSubmitPlan(
      DEMO_USER_ID,
      {
        goal: GOAL,
        nodes: [{ id: 'n1', name: '未知工具', dependencies: [], kind: 'tool', tool: 'rm_rf' }],
      },
      { sessionId, runTool: sessionRunTool(sessionId) },
    );

    expect(result.ok).toBe(false);
    expect(await getTestPrisma().agentTask.count({ where: { sessionId } })).toBe(0);
  });
});

describe('task control ownership', () => {
  it('reads an owned task and rejects an unknown task with NOT_FOUND', async () => {
    const sessionId = await newPersistedSessionId();
    const taskId = await seedTask(sessionId);

    const plan = await getTaskPlan(sessionId, taskId);
    expect(plan.id).toBe(taskId);
    expect(plan.goal).toBe('control probe');
    expect(plan.nodes.map((n) => n.id)).toEqual(['n1']);

    await expect(getTaskPlan(sessionId, 'task_missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(pauseTask(sessionId, 'task_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a foreign session on EVERY control path with SECURITY_DENIED', async () => {
    const sessionId = await newPersistedSessionId();
    const taskId = await seedTask(sessionId);
    const intruder = 'sess_intruder';

    await expect(getTaskPlan(intruder, taskId)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    await expect(pauseTask(intruder, taskId)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    await expect(resumeTask(intruder, taskId)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    await expect(cancelTask(intruder, taskId)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });
    await expect(retryTask(intruder, taskId)).rejects.toMatchObject({ code: 'SECURITY_DENIED' });

    // The foreign calls changed nothing.
    expect(await taskStatus(taskId)).toBe('pending');
  });

  it('pause / resume / cancel drive the persisted snapshot for an owned task', async () => {
    const sessionId = await newPersistedSessionId();
    const taskId = await seedTask(sessionId);

    const paused = await pauseTask(sessionId, taskId);
    expect(paused.status).toBe('paused');
    expect(await taskStatus(taskId)).toBe('paused');

    const resumed = await resumeTask(sessionId, taskId);
    expect(resumed.status).toBe('success');
    expect(await taskStatus(taskId)).toBe('success');
    const nodeRow = await getTestPrisma().agentTaskNode.findFirst({ where: { taskId } });
    expect(nodeRow!.status).toBe('success');

    const cancelled = await cancelTask(sessionId, taskId);
    expect(cancelled.status).toBe('cancelled');
    expect(await taskStatus(taskId)).toBe('cancelled');
  });
});
