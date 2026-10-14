/**
 * integration/transfer-history.test.ts — the UNIFIED TRANSACTION-FACT SOURCE.
 *
 * A COMMITTED transfer's facts (the ledger debit + the execution receipt) MUST survive changes to
 * MUTABLE reference data (a renamed / deleted recipient contact) and a PLAN CANCELLATION: the
 * already-posted side effect is never downgraded to `failed` / `cancelled`, never rolled back, and
 * never duplicated. Recovery is RECEIPT-FIRST — the committed evidence resolves the
 * recipient-independent facts BEFORE any name lookup — so a mutable contact can never break it.
 *
 * REAL stack: the REAL route handlers (`POST /api/actions/[id]/confirm`, `POST /api/tasks/[id]`,
 * `GET /api/actions`), the REAL agent confirmation continuation, the REAL security gateway and the
 * REAL Banking SDK over the isolated test SQLite. The ONLY mock is REAL fault injection: the atomic
 * result+status `$transaction` write is made to reject ONCE, so the SDK side effect commits while
 * the action stays `confirmed` with `resultJson = null` (the wedge this suite recovers from).
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as actionRepo from '@/lib/db/repositories/pendingAction';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';

const userId = 'user_liming';
/** The seeded 活期 account every transfer debits (¥23,580). */
const CHECKING = 'acct_checking';
const SEEDED_BALANCE = '23580.00';
/** The seeded recipient resolved by name. */
const CONTACT = 'contact_zhangwei';
const AMOUNT = '200';
const AFTER_TRANSFER = subtractMoney(SEEDED_BALANCE, AMOUNT);

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** `POST /api/actions/[id]/confirm` through the REAL route handler. */
async function confirm(id: string, s: string) {
  const response = await confirmPost(
    new NextRequest(`http://localhost/api/actions/${id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { http: response.status, body: await response.json() };
}

/** `POST /api/tasks/[id]` (`pause` | `resume` | `cancel` | `retry`) through the REAL route handler. */
async function task(id: string, action: string, s: string) {
  const response = await taskPost(
    new NextRequest(`http://localhost/api/tasks/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { http: response.status, body: await response.json() };
}

async function list(s: string) {
  const response = await actionsGet(
    new NextRequest('http://localhost/api/actions', { headers: { cookie: `banking_session=${s}` } }),
  );
  expect(response.status).toBe(200);
  return (await response.json()).data as Array<{ id: string; status: string }>;
}

/**
 * The committed debit row of the wedged transfer (throws when absent — a bug). Scoped to the
 * RECIPIENT so it can never be satisfied by an unrelated seeded ¥200 transaction.
 */
function debitRow() {
  return getTestPrisma().transaction.findFirstOrThrow({
    where: { userId, amountMinor: -moneyToCents(AMOUNT), counterpartyId: CONTACT },
  });
}
/** The transfer's own debit rows (the ledger fact): exactly ONE for a committed transfer. */
function transferDebits() {
  return getTestPrisma().transaction.count({
    where: { userId, amountMinor: -moneyToCents(AMOUNT), counterpartyId: CONTACT },
  });
}
/**
 * EVERY ¥200 debit of the demo user — including the seeded unrelated one. Used as a DELTA baseline
 * so "no second debit was ever created" is proven against the whole ledger, not just the scoped rows.
 */
function amountDebits() {
  return getTestPrisma().transaction.count({ where: { userId, amountMinor: -moneyToCents(AMOUNT) } });
}
async function balance() {
  return centsToMoney((await getTestPrisma().account.findUniqueOrThrow({ where: { id: CHECKING } })).balanceMinor);
}

/**
 * Gate a STANDALONE ¥200 `transfer_money` to 张伟, then WEDGE it: the atomic
 * result+status `$transaction` write rejects ONCE, so the debit COMMITS while the action is left
 * `confirmed` with `resultJson = null`. Asserts the fault injection really HIT (spy count == 1) and
 * the wedged precondition holds (status `confirmed`, null result, exactly ONE debit) BEFORE the
 * caller recovers — so a passing recovery can never be an artefact of a missed fault.
 */
async function transferWedge(s: string) {
  const gate = await executeGatedTool({
    sessionId: s,
    userId,
    toolName: 'transfer_money',
    args: { name: '张伟', amount: AMOUNT },
    userRequest: '给张伟转200元',
  });
  const id = gate.pendingActionId!;
  expect(id).toBeTruthy();
  expect(gate.requiresConfirmation).toBe(true);

  const spy = vi
    .spyOn(actionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: result write failed after debit'));
  const first = await confirm(id, s);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();

  const row = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id } });
  expect(first.http).toBe(500);
  expect(row.status).toBe('confirmed');
  expect(row.resultJson).toBeNull();
  expect(await transferDebits()).toBe(1);
  expect(await balance()).toBe(AFTER_TRANSFER);
  return id;
}

it('REVIEW_TXN_CONTACT_RENAMED — a committed transfer is recovered from its committed evidence after the recipient contact is renamed', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const debitsBefore = await amountDebits();
  const id = await transferWedge(s);

  // The recipient is MUTABLE reference data: renaming it must not change the committed facts.
  await p.contact.update({ where: { id: CONTACT }, data: { name: '张伟（已更名）' } });

  const repeated = await confirm(id, s);
  const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const debit = await debitRow();
  const transferDebitsAfter = await transferDebits();
  const debitsAfter = await amountDebits();
  const finalBalance = await balance();

  console.log(
    'REVIEW_TXN_CONTACT_RENAMED',
    JSON.stringify({
      http: repeated.http,
      ok: repeated.body.data?.ok,
      status: repeated.body.data?.status,
      message: repeated.body.data?.message,
      storedStatus: row.status,
      resultOk: JSON.parse(row.resultJson ?? 'null')?.ok,
      debitsBefore,
      debitsAfter,
      transferDebitsAfter,
      finalBalance,
      debitCounterparty: debit.counterpartyId,
    }),
  );

  // The API reports a REAL recovery from committed evidence — never a re-execution.
  expect(repeated.http).toBe(200);
  expect(repeated.body.data?.ok).toBe(true);
  expect(repeated.body.data?.status).toBe('executed');
  expect(repeated.body.data?.message).toContain('执行凭证');
  expect(repeated.body.data?.message).toContain('未重新执行');

  // The action is settled consistently with the committed ledger.
  expect(row.status).toBe('executed');
  expect(JSON.parse(row.resultJson!).ok).toBe(true);

  // Balance + ledger rows agree, and the debit is EXACTLY once (no replay, no rollback).
  expect(finalBalance).toBe(AFTER_TRANSFER);
  expect(transferDebitsAfter).toBe(1);
  expect(debitsAfter).toBe(debitsBefore + 1);
  expect(debit.counterpartyId).toBe(CONTACT);
  expect(debit.amountMinor).toBe(-moneyToCents(AMOUNT));
});

it('REVIEW_TXN_CONTACT_DELETED — recovery survives deletion of the recipient contact (the committed evidence is looked up first)', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const debitsBefore = await amountDebits();
  const id = await transferWedge(s);

  // The recipient no longer exists at all: recovery must NOT depend on resolving it by name.
  await p.contact.delete({ where: { id: CONTACT } });
  expect(await p.contact.count({ where: { id: CONTACT } })).toBe(0);

  const repeated = await confirm(id, s);
  const row = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const transferDebitsAfter = await transferDebits();
  const debitsAfter = await amountDebits();
  const finalBalance = await balance();

  console.log(
    'REVIEW_TXN_CONTACT_DELETED',
    JSON.stringify({
      http: repeated.http,
      ok: repeated.body.data?.ok,
      status: repeated.body.data?.status,
      message: repeated.body.data?.message,
      storedStatus: row.status,
      debitsBefore,
      debitsAfter,
      transferDebitsAfter,
      finalBalance,
    }),
  );

  expect(repeated.http).toBe(200);
  expect(repeated.body.data?.ok).toBe(true);
  expect(repeated.body.data?.status).toBe('executed');
  expect(row.status).toBe('executed');
  // The debit is retained exactly once, still referencing the (now deleted) contact id.
  expect(transferDebitsAfter).toBe(1);
  expect(debitsAfter).toBe(debitsBefore + 1);
  expect(finalBalance).toBe(AFTER_TRANSFER);
});

it('REVIEW_TXN_PLAN_CANCEL — a committed plan transfer fact is retained across a plan cancellation and never downgraded', async () => {
  const s = (await getDemoSession(userId)).sessionId;
  const p = getTestPrisma();
  const debitsBefore = await amountDebits();

  // Drive a plan whose ONLY node is a GATED transfer: it PARKS instead of executing.
  const seeded = await runSubmitPlan(
    userId,
    {
      goal: '取消计划后已提交转账事实保留',
      nodes: [
        {
          id: 'transfer',
          name: '给张伟转账',
          kind: 'tool',
          tool: 'transfer_money',
          args: { name: '张伟', amount: AMOUNT },
          dependencies: [],
        },
      ],
    },
    {
      sessionId: s,
      runTool: (tool, args, ctx) =>
        executeGatedTool({
          sessionId: s,
          userId,
          toolName: tool as Parameters<typeof executeGatedTool>[0]['toolName'],
          args,
          userRequest: '取消计划后已提交转账事实保留',
          taskId: ctx.taskId,
          nodeId: ctx.nodeId,
        }),
    },
  );
  const plan: any = seeded.data;
  expect(plan).toBeDefined();
  expect(plan.status).toBe('waiting_confirmation');

  const action = await p.pendingAction.findFirstOrThrow({ where: { sessionId: s } });
  expect(action.taskId).toBe(plan.id);
  expect(action.status).toBe('pending');
  // Nothing has moved yet: the node is PARKED, not executed.
  expect(await transferDebits()).toBe(0);
  expect(await amountDebits()).toBe(debitsBefore);
  expect(await balance()).toBe(SEEDED_BALANCE);

  // WEDGE the gated node's confirm: the debit COMMITS, the atomic result+status write fails once.
  const spy = vi
    .spyOn(actionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: plan node result write failed after debit'));
  const first = await confirm(action.id, s);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  expect(first.http).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  expect(await transferDebits()).toBe(1);
  expect(await balance()).toBe(AFTER_TRANSFER);

  // CANCEL the plan (real route handler).
  const cancelled = await task(plan.id, 'cancel', s);

  // A cancelled plan is TERMINAL: it may not be resumed back into life.
  const resumed = await task(plan.id, 'resume', s);

  const afterCancelRow = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  const afterCancelDebits = await transferDebits();
  const afterCancelAmountDebits = await amountDebits();
  const afterCancelBalance = await balance();
  const storedPlan = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id } });

  // Repeat the human decision after the cancellation — a cancelled plan fails CLOSED.
  const repeated = await confirm(action.id, s);
  const afterRepeatRow = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  const afterRepeatDebits = await transferDebits();
  const afterRepeatAmountDebits = await amountDebits();
  const afterRepeatBalance = await balance();
  const afterResumeRow = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  const visible = await list(s);
  const debit = await debitRow();

  console.log(
    'REVIEW_TXN_PLAN_CANCEL',
    JSON.stringify({
      cancelHttp: cancelled.http,
      cancelStatus: cancelled.body.data?.status,
      storedPlanStatus: storedPlan.status,
      afterCancelAction: afterCancelRow.status,
      afterCancelDebits,
      afterCancelAmountDebits,
      afterCancelBalance,
      repeatedHttp: repeated.http,
      repeatedOk: repeated.body.data?.ok,
      repeatedStatus: repeated.body.data?.status,
      repeatedMessage: repeated.body.data?.message,
      afterRepeatAction: afterRepeatRow.status,
      afterRepeatDebits,
      afterRepeatAmountDebits,
      afterRepeatBalance,
      visible: visible.some((a) => a.id === action.id),
      resumeHttp: resumed.http,
      resumeStatus: resumed.body.data?.status,
      afterResumeAction: afterResumeRow.status,
      debitsBefore,
      debitCounterparty: debit.counterpartyId,
    }),
  );

  // ── The cancellation itself is a real, terminal plan transition. ──────────────────────────────
  expect(cancelled.http).toBe(200);
  expect(cancelled.body.data?.status).toBe('cancelled');
  expect(storedPlan.status).toBe('cancelled');
  expect(resumed.body.data?.status).toBe('cancelled'); // a cancelled plan never resurrects

  // ── The COMMITTED transfer fact is RETAINED across the cancellation: the debit is still there
  //    EXACTLY once, the balance is consistent (−amount), and the action is NOT downgraded to
  //    `cancelled`/`failed` — i.e. it is never left inconsistent with the committed ledger. ───────
  expect(afterCancelRow.status).not.toBe('cancelled');
  expect(afterCancelRow.status).not.toBe('failed');
  expect(afterCancelRow.status).toBe('confirmed');
  expect(afterCancelDebits).toBe(1);
  expect(afterCancelAmountDebits).toBe(debitsBefore + 1); // no second debit anywhere in the ledger
  expect(afterCancelBalance).toBe(AFTER_TRANSFER);
  expect(debit.counterpartyId).toBe(CONTACT);
  expect(debit.amountMinor).toBe(-moneyToCents(AMOUNT));

  // ── The repeat human decision on the cancelled plan is REFUSED (fails closed), it does NOT move
  //    money again and does NOT settle the retained fact as a failure/cancellation. ───────────────
  expect(repeated.http).toBe(200);
  expect(repeated.body.data?.ok).toBe(false);
  expect(repeated.body.data?.message).toContain('任务计划已取消');
  expect(repeated.body.data?.message).toContain('已拒绝执行');
  expect(afterRepeatRow.status).toBe('confirmed');
  expect(afterRepeatRow.status).not.toBe('cancelled');
  expect(afterRepeatRow.status).not.toBe('failed');
  expect(afterRepeatDebits).toBe(1);
  expect(afterRepeatAmountDebits).toBe(debitsBefore + 1);
  expect(afterRepeatBalance).toBe(AFTER_TRANSFER);

  // ── The retained wedge is still VISIBLE to the operator (surfaced by `GET /api/actions`), and a
  //    resume attempt (terminal plan) neither revives the plan nor touches the committed fact. ────
  expect(visible.some((a) => a.id === action.id)).toBe(true);
  expect(afterResumeRow.status).toBe('confirmed');
  expect(afterResumeRow.status).not.toBe('cancelled');
  expect(afterResumeRow.status).not.toBe('failed');
  expect(await transferDebits()).toBe(1);
  expect(await balance()).toBe(AFTER_TRANSFER);
});
