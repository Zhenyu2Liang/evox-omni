/**
 * tests/app/confirm-continuation-no-owner-fencing.test.ts — the NO-OWNER fence branch (branch 3) of
 * the confirm-continuation decision recorder `agent/task-fencing.ts#recordDecidedNodeFenced`.
 *
 * THE CONTRACT UNDER TEST. When the confirm/verify continuation LOST the plan's execution claim it
 * must still record the HUMAN-decided node — but never clobber a plan/node row another owner has
 * since taken over. `recordDecidedNodeFenced` fences that write on, in precedence order, (1) the
 * node's OWN `AgentTaskNode.executionToken`, (2) the LIVE owner's `AgentTask.executionToken`, else
 * (3) — with NO owner left at all — a single atomic NO-OWNER CAS:
 *
 *   `updateMany({ where: { taskId, nodeId, task: { executionToken: null } }, … })`
 *
 * i.e. the write lands only while the plan STILL holds no execution token (`task: { executionToken:
 * null }` — the same predicate `settlePlanFromNodes` uses). A takeover that ACQUIRED the claim
 * between the read and this write makes the statement match 0 rows, so the stale result is SKIPPED
 * (`false`) instead of overwriting the takeover's row. With NO executor left, a successful write
 * then settles the plan status from its now-terminal node rows (`settlePlanFromNodes`), so a plan
 * whose every node is terminal can never dangle a stale `waiting_confirmation`.
 *
 * TWO SPECS:
 *  A. NO-OWNER happy path — the decision is recorded, the node row becomes terminal and the plan is
 *     SETTLED to `success`; the parked `PendingAction` is left completely untouched (the recorder
 *     never resolves an action — that is the gateway's job).
 *  B. TAKEOVER-during-write race — a takeover claims the plan INSIDE the recorder's own write window
 *     (injected by spying on the REAL delegate and calling the bound original), so the NO-OWNER CAS
 *     genuinely matches 0 rows: the recorder returns `false`, the decided node is NOT overwritten and
 *     no settle/advance happens. The CAS result is NEVER fabricated — the spy drives the real
 *     statement against the real DB.
 *
 * The whole production stack runs (production planner → banking tools → Security Gateway
 * `beforeToolCall` → Banking SDK → SQLite); only the model is scripted (`tests/setup.ts` forces
 * `LLM_MODE=mock`) — offline, no network, no fake timers, no wall-clock races. Plans are SEEDED
 * through the production APIs (`getOrCreateSession` + `runSubmitPlan`) so real
 * `AgentTask`/`AgentTaskNode`/`PendingAction` rows exist. Each test gets a fresh DB
 * (`resetDatabase`) and a UNIQUE persisted session id (the in-process circuit breaker is keyed by
 * `sessionId`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeGatedTool,
  getOrCreateSession,
  readPendingActionId,
  recordDecidedNodeFenced,
} from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';

/* ------------------------------------------------------------------------------- fixtures */

/** Recipient 张伟 — the parked transfer's payee. */
const ZHANGWEI = CONTACTS.find((contact) => contact.name === '张伟')!;
/** The parked transfer amount (≤ ¥1000 ⇒ YELLOW / confirmation-only). */
const TRANSFER_AMOUNT = '200';
/** The pre-existing 🟢 node's countable side-effect marker — exactly ONE `Budget` row per execution. */
const MARKER_BUDGET = '无主续行预算A';
/** The token a simulated takeover stamps on the plan WHILE the recorder is writing. */
const TAKEOVER_TOKEN = 'takeover-b';
/** The decided outcome (branch-3 happy path) recorded onto the parked node. */
const DECIDED_DATA = { status: 'executed', recipient: '张伟', amount: '200.00' };

/* ----------------------------------------------------------------------------- plan seeding */

/** A plan node as supplied to `runSubmitPlan` (the model-free DAG runner). */
interface SeedNode {
  id: string;
  name: string;
  dependencies: string[];
  kind: 'tool' | 'condition' | 'note';
  tool?: string;
  args?: Record<string, unknown>;
}

/** A 🟢 GREEN node used as the COUNTABLE execution probe (one `Budget` row per real execution). */
function budgetNode(id: string, budgetName: string, amount: string, deps: string[] = []): SeedNode {
  return {
    id,
    name: '预留预算',
    dependencies: deps,
    kind: 'tool',
    tool: 'reserve_budget',
    args: { name: budgetName, amount },
  };
}

/** The YELLOW `transfer_money` node (gated → PARKS for a human decision instead of executing). */
function transferNode(id: string, amount: string, deps: string[] = []): SeedNode {
  return {
    id,
    name: `给${ZHANGWEI.name}转账`,
    dependencies: deps,
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: ZHANGWEI.name, amount },
  };
}

/** Create + persist a fresh `AgentSession` for the demo user and return its (unique) id. */
async function sender(): Promise<string> {
  return (await getOrCreateSession(DEMO_USER_ID)).sessionId;
}

/**
 * The gateway-routed per-node runner: every node passes its `{taskId, nodeId}` node identity, so a
 * gated node parks with a PERSISTED plan link and the SDK idempotency key is the node identity.
 */
function gatewayRunTool(sessionId: string): PlanRunTool {
  return (toolName, args, ctx) =>
    executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName,
      args,
      userRequest: '',
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });
}

/** The recorded node status in a plan snapshot (`undefined` when the node is absent). */
function nodeStatusOf(plan: TaskPlan, nodeId: string): TaskNodeStatus | undefined {
  return plan.results.find((result) => result.id === nodeId)?.status;
}

/** Decode a persisted JSON-text column; a NULL value is a hard failure (never silently swallowed). */
function decodeJson(raw: string | null): unknown {
  expect(raw, 'the persisted node output must be present').not.toBeNull();
  return JSON.parse(raw!) as unknown;
}

/** The durable row of ONE node (a missing node row is a bug). */
async function nodeRowOf(taskId: string, nodeId: string) {
  const row = await getTestPrisma().agentTaskNode.findFirst({ where: { taskId, nodeId } });
  expect(row, `AgentTaskNode ${taskId}/${nodeId} must exist`).not.toBeNull();
  return row!;
}

/** The durable `AgentTask` row (its claim columns ARE the ownership state under test). */
function taskRowOf(taskId: string) {
  return getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
}

/** The parked `PendingAction` row (branch 3 must NEVER resolve it — that is the gateway's job). */
function actionRowOf(actionId: string) {
  return getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
}

/** Count the `Budget` rows with the given name (0 ⇒ never ran; 2 ⇒ ran twice). */
function countBudgets(name: string): Promise<number> {
  return getTestPrisma().budget.count({ where: { userId: DEMO_USER_ID, name } });
}

/** Everything a spec needs about a freshly seeded, PARKED two-node plan with NO owner left. */
interface SeededPark {
  sessionId: string;
  taskId: string;
  actionId: string;
}

/**
 * Seed a TWO-node plan through the production `submit_plan` runner — `n1` 🟢 `reserve_budget`
 * (executes → `success`) → `n2` 🟡 `transfer_money` (YELLOW ⇒ PARKS). NO downstream node: after the
 * decided node is recorded EVERY node row is terminal, so branch 3's `settlePlanFromNodes` pass may
 * settle the plan. `runSubmitPlan` releases its plan claim in `finally`, and BOTH tokens are cleared
 * explicitly so the recorder deterministically takes the NO-OWNER branch.
 */
async function seedParkedNoOwnerPlan(): Promise<SeededPark> {
  const sessionId = await sender();

  const seeded = await runSubmitPlan(
    DEMO_USER_ID,
    {
      goal: '先预留一笔预算，再给张伟转200元',
      nodes: [budgetNode('n1', MARKER_BUDGET, '600'), transferNode('n2', TRANSFER_AMOUNT, ['n1'])],
    },
    { sessionId, runTool: gatewayRunTool(sessionId) },
  );
  const plan = seeded.data as TaskPlan | undefined;
  expect(plan, `runSubmitPlan produced no plan: ${seeded.error}`).toBeDefined();
  const taskId = plan!.id;

  // Seed preconditions: the upstream 🟢 node executed, the gated node PARKED.
  expect(nodeStatusOf(plan!, 'n1')).toBe('success');
  expect(nodeStatusOf(plan!, 'n2')).toBe('waiting_confirmation');
  expect(await countBudgets(MARKER_BUDGET)).toBe(1);

  const parkedNode = plan!.results.find((result) => result.id === 'n2')!;
  const actionId = readPendingActionId(parkedNode.output);
  expect(typeof actionId, 'the parked node must expose its PendingAction id').toBe('string');

  // NO OWNER: clear both claim columns explicitly (the runner already released the plan claim).
  const prisma = getTestPrisma();
  await prisma.agentTask.update({
    where: { id: taskId },
    data: { executionToken: null, executionClaimedAt: null },
  });
  await prisma.agentTaskNode.updateMany({ where: { taskId }, data: { executionToken: null } });

  expect((await taskRowOf(taskId)).executionToken).toBeNull();
  expect((await nodeRowOf(taskId, 'n2')).executionToken).toBeNull();

  return { sessionId, taskId, actionId: actionId! };
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] recordDecidedNodeFenced — the NO-OWNER fence branch', () => {
  it('[integration] records the decided node through the no-owner CAS, settles the plan to success, and leaves the parked action untouched', async () => {
    const { taskId, actionId } = await seedParkedNoOwnerPlan();

    const written = await recordDecidedNodeFenced({
      taskId,
      nodeId: 'n2',
      outcome: { ok: true, data: DECIDED_DATA },
    });
    expect(written, 'with NO owner left the no-owner CAS must land').toBe(true);

    // THE DECIDED NODE: terminal `success` carrying the REAL tool result.
    const decided = await nodeRowOf(taskId, 'n2');
    expect(decided.status).toBe('success');
    expect(decided.error).toBeNull();
    expect(decodeJson(decided.output)).toEqual(DECIDED_DATA);

    // THE PLAN IS SETTLED from its now-terminal node rows (no executor is left to publish it).
    const task = await taskRowOf(taskId);
    expect(task.status).toBe('success');

    // THE PARKED ACTION IS UNTOUCHED — the recorder records the decision, it never resolves an action.
    const parked = await actionRowOf(actionId);
    expect(parked.status).toBe('pending');
    expect(parked.resultJson).toBeNull();
  });

  it('[integration] SKIPS the write (`false`) when a takeover claims the plan inside the write window — the decided node is not overwritten and nothing settles', async () => {
    const { taskId, actionId } = await seedParkedNoOwnerPlan();

    // The parked node's ORIGINAL persisted output — captured before the record attempt.
    const originalOutput = (await nodeRowOf(taskId, 'n2')).output;
    expect(decodeJson(originalOutput)).toEqual({ pendingActionId: actionId });

    const prisma = getTestPrisma();
    // The UNIQUE branch-3 predicate: branch 2 fences on the LIVE owner's (NON-NULL) plan token, so a
    // `task.executionToken === null` relation filter is only ever produced by the no-owner CAS.
    const original = prisma.agentTaskNode.updateMany.bind(prisma.agentTaskNode);
    vi.spyOn(prisma.agentTaskNode, 'updateMany').mockImplementation((async (args: any) => {
      if (args?.where?.task && args.where.task.executionToken === null) {
        // A TAKEOVER grabs the plan BETWEEN the recorder's read and its CAS…
        await prisma.agentTask.update({
          where: { id: args.where.taskId },
          data: {
            executionToken: TAKEOVER_TOKEN,
            executionClaimedAt: new Date(),
            status: 'running',
          },
        });
      }
      // …then the REAL statement runs, so the `task: { executionToken: null }` filter genuinely
      // matches 0 rows — the CAS result is never fabricated.
      return original(args);
    }) as any);

    const written = await recordDecidedNodeFenced({
      taskId,
      nodeId: 'n2',
      outcome: { ok: true, data: DECIDED_DATA },
    });
    expect(written, 'a takeover must make the no-owner CAS match 0 rows').toBe(false);

    // THE DECIDED NODE IS NOT OVERWRITTEN — it keeps its ORIGINAL parked state.
    const node = await nodeRowOf(taskId, 'n2');
    expect(node.status).toBe('waiting_confirmation');
    expect(decodeJson(node.output)).toEqual({ pendingActionId: actionId });

    // THE PLAN IS UNTOUCHED APART FROM THE TAKEOVER'S OWN WRITE — no settle, no advance.
    const task = await taskRowOf(taskId);
    expect(task.executionToken).toBe(TAKEOVER_TOKEN);
    expect(task.status).toBe('running');
    expect(task.executionClaimedAt).not.toBeNull();
    expect(task.status).not.toBe('success');
    expect(node.status).not.toBe('success');

    // The parked action is likewise untouched — nothing was decided into it.
    const parked = await actionRowOf(actionId);
    expect(parked.status).toBe('pending');
    expect(parked.resultJson).toBeNull();
  });
});
