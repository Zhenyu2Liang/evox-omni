/**
 * task-cancel-revokes.test.ts — the three cancellation invariants of a durable `submit_plan` DAG,
 * exercised against the REAL `@/agent` control glue, the REAL security gateway, the REAL Banking SDK
 * and the test SQLite (only the model is the `LLM_MODE=mock` faux provider).
 *
 * Invariants under test:
 *   1. REVOCATION — `cancelTask` revokes the plan's parked `PendingAction`(s) via the gateway's
 *      atomic claim, so a LATER `confirmAction` of that action FAILS and NO money moves.
 *   2. RACE — a cancel running concurrently with a confirm of the same parked action leaves AT MOST
 *      ONE effect: the action can never execute twice (never a double debit) and never dangles in
 *      `pending`.
 *   3. PRESERVATION — cancelling a plan NEVER fakes a rollback: an already-executed (`success`) node
 *      keeps its result, and any transaction it caused still exists (the money is NOT moved back).
 *
 * Offline + deterministic: a UNIQUE persisted session per test keeps the in-process circuit breaker
 * (keyed by `sessionId`, no global reset) isolated; the plan routes every node through the gateway via
 * `executeGatedTool` (mirrors `task-control.test.ts`).
 *
 * Runs under the default config: `npm run test`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cancelTask,
  confirmAction,
  executeGatedTool,
  getOrCreateSession,
  getTaskPlan,
  readPendingActionId,
} from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { TaskPlan } from '@/lib/contracts/task';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

/** Recipient 张伟 — resolves unambiguously to the seeded contact. */
const RECIPIENT = CONTACTS[0];
/** ≤ ¥1000 ⇒ YELLOW (confirmation-only); a successful transfer debits exactly this. */
const TRANSFER_AMOUNT = 200;
/** The default funding account (`tests/helpers/fixtures.ACCOUNTS`). */
const FUNDING_ACCOUNT_ID = 'acct_checking';
/** Seeded 活期 balance; a single ¥200 debit yields `STARTING_BALANCE - TRANSFER_AMOUNT`. */
const STARTING_BALANCE = 23580;

const GOAL = '先查余额再给张伟转200元';

/** A two-step DAG: a GREEN read, then a YELLOW transfer (which must PARK for a human decision). */
const READ_THEN_TRANSFER: Record<string, unknown>[] = [
  { id: 'n1', name: '查询余额', dependencies: [], kind: 'tool', tool: 'get_balance', args: {} },
  {
    id: 'n2',
    name: '给张伟转账',
    dependencies: ['n1'],
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: RECIPIENT.name, amount: TRANSFER_AMOUNT },
  },
];

/** A two-step chain of YELLOW transfers: n1 executes on confirm, then n2 parks on the resumed plan. */
const TRANSFER_THEN_TRANSFER: Record<string, unknown>[] = [
  {
    id: 'n1',
    name: '第一笔转账',
    dependencies: [],
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: RECIPIENT.name, amount: TRANSFER_AMOUNT },
  },
  {
    id: 'n2',
    name: '第二笔转账',
    dependencies: ['n1'],
    kind: 'tool',
    tool: 'transfer_money',
    args: { name: RECIPIENT.name, amount: TRANSFER_AMOUNT },
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
  return (toolName: string, args: Record<string, unknown>) =>
    executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: toolName as Parameters<typeof executeGatedTool>[0]['toolName'],
      args,
      userRequest: GOAL,
    });
}

/** Persist + run a plan through the real gateway-authorized path and return its durable id + snapshot. */
async function runPlan(
  sessionId: string,
  nodes: Record<string, unknown>[],
): Promise<{ taskId: string; plan: TaskPlan }> {
  const result = await runSubmitPlan(
    DEMO_USER_ID,
    { goal: GOAL, nodes },
    { sessionId, runTool: sessionRunTool(sessionId) },
  );
  expect(result.ok).toBe(true);
  const plan = result.data as TaskPlan;
  return { taskId: plan.id, plan };
}

/** The funding account's current balance (the money-movement proof). */
async function balanceOf(accountId: string = FUNDING_ACCOUNT_ID): Promise<number> {
  const row = await getTestPrisma().account.findUnique({ where: { id: accountId } });
  return row!.balance;
}

/** The persisted status of a `PendingAction`. */
async function actionStatus(actionId: string): Promise<string> {
  const row = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
  return row!.status;
}

/** How many `TRANSFER` ledger rows were written to the seeded recipient (0 before any transfer). */
async function transferTxCount(counterpartyId: string = RECIPIENT.id): Promise<number> {
  return getTestPrisma().transaction.count({
    where: { counterpartyId, channel: 'TRANSFER' },
  });
}

/** Read the `pendingActionId` a parked node recorded in its `output` (via the public reader). */
function parkedActionId(plan: TaskPlan, nodeIndex: number): string {
  const actionId = readPendingActionId(plan.results[nodeIndex].output);
  expect(typeof actionId).toBe('string');
  expect((actionId ?? '').length).toBeGreaterThan(0);
  return actionId!;
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ tests */

describe('cancelTask revokes parked actions', () => {
  it('cancelTask revokes the parked action — a later confirm fails and no money moves', async () => {
    const sessionId = await newPersistedSessionId();
    const { taskId, plan } = await runPlan(sessionId, READ_THEN_TRANSFER);

    // The plan parked on n2 (YELLOW transfer) with a persisted PendingAction.
    expect(plan.status).toBe('waiting_confirmation');
    const actionId = parkedActionId(plan, 1);
    const parked = await getTestPrisma().pendingAction.findUnique({ where: { id: actionId } });
    expect(parked!.toolName).toBe('transfer_money');
    expect(await actionStatus(actionId)).toBe('pending');

    const before = await balanceOf();
    expect(before).toBe(STARTING_BALANCE);

    // Cancel the plan: it must revoke the parked action BEFORE cancelling the plan.
    const cancelled = await cancelTask(sessionId, taskId);
    expect(cancelled.status).toBe('cancelled');
    expect(await actionStatus(actionId)).toBe('cancelled');

    // A late confirm of the revoked action does NOT execute — it is a typed domain outcome.
    const late = await confirmAction(actionId);
    expect(late.ok).toBe(false);
    expect(late.status).toBe('cancelled');
    expect(late.actionId).toBe(actionId);

    // No money moved and no transfer ledger row was created.
    expect(await balanceOf()).toBe(STARTING_BALANCE);
    expect(await transferTxCount()).toBe(0);
    expect(await actionStatus(actionId)).toBe('cancelled');

    // The executed GREEN node is preserved; the parked node is recorded cancelled.
    const reloaded = await getTaskPlan(sessionId, taskId);
    expect(reloaded.status).toBe('cancelled');
    expect(reloaded.results[0].status).toBe('success');
    expect(reloaded.results[1].status).toBe('cancelled');
  });
});

describe('cancel-vs-confirm race', () => {
  it('a cancel racing a confirm leaves at most one effect', async () => {
    const sessionId = await newPersistedSessionId();
    const { taskId, plan } = await runPlan(sessionId, READ_THEN_TRANSFER);

    expect(plan.status).toBe('waiting_confirmation');
    const actionId = parkedActionId(plan, 1);
    expect(await actionStatus(actionId)).toBe('pending');

    // Fire BOTH human decisions at once; every rejection is swallowed so nothing escapes.
    const settled = await Promise.allSettled([
      confirmAction(actionId).catch((error: unknown) => error),
      cancelTask(sessionId, taskId).catch((error: unknown) => error),
    ]);
    expect(settled).toHaveLength(2);
    expect(settled.every((outcome) => outcome.status === 'fulfilled')).toBe(true);

    // The action is settled in a TERMINAL state — it may never be left `pending`.
    const status = await actionStatus(actionId);
    expect(status).not.toBe('pending');
    expect(['executed', 'cancelled', 'failed']).toContain(status);

    // AT MOST ONE effect: the balance is exactly untouched or exactly one debit — never double.
    const balance = await balanceOf();
    const txs = await transferTxCount();
    expect(txs).toBeLessThanOrEqual(1);
    expect([23380, 23580]).toContain(balance);

    // The money state and the terminal action status must agree (one coherent outcome).
    if (balance === STARTING_BALANCE - TRANSFER_AMOUNT) {
      expect(status).toBe('executed');
      expect(txs).toBe(1);
    } else {
      expect(balance).toBe(STARTING_BALANCE);
      expect(status).toBe('cancelled');
      expect(txs).toBe(0);
    }
  });
});

describe('cancel preserves already-executed work', () => {
  it('an executed node keeps its result and its transaction on cancel (no fake rollback)', async () => {
    const sessionId = await newPersistedSessionId();
    const { taskId, plan } = await runPlan(sessionId, TRANSFER_THEN_TRANSFER);

    // n1 (YELLOW transfer) parks; n2 waits on it and has not run.
    expect(plan.status).toBe('waiting_confirmation');
    expect(plan.results[0].status).toBe('waiting_confirmation');
    expect(plan.results[1].status).toBe('pending');
    const n1ActionId = parkedActionId(plan, 0);

    // Confirm n1: it executes (¥200 once), then the plan resumes and PARKS on n2.
    await confirmAction(n1ActionId).catch(() => undefined);

    // Money moved exactly once for the executed node.
    expect(await balanceOf()).toBe(STARTING_BALANCE - TRANSFER_AMOUNT);
    expect(await transferTxCount()).toBe(1);

    // n1 is now `success`; n2 is parked awaiting its own human decision.
    const afterConfirm = await getTaskPlan(sessionId, taskId);
    expect(afterConfirm.status).toBe('waiting_confirmation');
    expect(afterConfirm.results[0].status).toBe('success');
    expect(afterConfirm.results[0].output).toBeDefined();
    expect(afterConfirm.results[1].status).toBe('waiting_confirmation');
    const n1Result = afterConfirm.results[0].output;
    const n2ActionId = parkedActionId(afterConfirm, 1);
    expect(n2ActionId).not.toBe(n1ActionId);

    // Cancel the plan.
    const cancelled = await cancelTask(sessionId, taskId);
    expect(cancelled.status).toBe('cancelled');

    // The executed node is PRESERVED (status + result intact); only the pending node is cancelled.
    const reloaded = await getTaskPlan(sessionId, taskId);
    expect(reloaded.status).toBe('cancelled');
    expect(reloaded.results[0].status).toBe('success');
    expect(reloaded.results[0].output).toEqual(n1Result);
    expect(reloaded.results[1].status).toBe('cancelled');

    // Cancel rolled back NOTHING: the executed ¥200 debit and its ledger row still exist.
    expect(await balanceOf()).toBe(STARTING_BALANCE - TRANSFER_AMOUNT);
    expect(await transferTxCount()).toBe(1);

    // The plan's remaining parked action was revoked; the executed one is terminal (`executed`).
    expect(await actionStatus(n2ActionId)).toBe('cancelled');
    expect(await actionStatus(n1ActionId)).toBe('executed');
  });
});
