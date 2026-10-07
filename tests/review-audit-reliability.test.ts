/**
 * review-audit-reliability.test.ts — EXECUTION/RECOVERY AUDIT reliability regressions.
 *
 * WHY this suite exists: the audit log is the durable record of the agent loop
 * (理解 → 规划 → 执行 → 风控 → 验证 → 审计). A money-moving gated action's audit is written
 * INSIDE the SAME `prisma.$transaction` as its result + terminal status
 * (`agent/confirmation-recovery.ts#settlePendingAction` → `recordAudit(..., { dedupeKey:
 * 'exec:<id>', strict: true })`). This spec pins the three guarantees that make that record
 * RELIABLE:
 *
 *  (1) CRITICAL-FAILURE → ROLLBACK — if the execution audit insert throws, the settle rolls back
 *      ATOMICALLY (the row must NOT be finalized `executed`/`failed` without its audit), while the
 *      SDK side effect that committed BEFORE the settle stays committed EXACTLY ONCE. A later
 *      recovery re-settles it and backfills the missing audit — without a second debit.
 *  (2) BACKFILL — a HISTORICAL row whose side effect posted but whose execution audit is missing
 *      (a legacy/pre-upgrade row) is BACKFILLED on recovery: the recover path re-writes the audit
 *      from the committed receipt, lands `executed` (NEVER `failed`) and a REPEAT recovery adds no
 *      second audit and no second debit. (Empirically verified — see the assertions.)
 *  (3) IDEMPOTENT REPEAT — two consecutive recoveries leave EXACTLY ONE execution audit and
 *      EXACTLY ONE debit; the success is never downgraded.
 *
 * Real app-entry layer: the REAL Next.js route handlers, the REAL confirmation continuation, the
 * REAL Banking SDK and the REAL isolated test SQLite (`prisma/test.db`) run in-process. The ONLY
 * mocks are REAL fault injections that make a real write fail — never a fabricated return value.
 * Every assertion re-reads persisted DB state.
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { auditStore } from '@/audit/audit-logger';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
/** Seeded 活期 balance (fixtures ACCOUNTS) — debited by the transferred amount. */
const CHECKING_BALANCE = 23580;

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** A real route handler's `POST` for `/…/[id]` (app-layer `IdRouteContext`). */
type RoutePost = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

/** POST `/api/actions/[id]/<verb>` with the trusted cookie identity. */
async function postAction(handler: RoutePost, id: string, sessionId: string, verb: string) {
  const res = await handler(
    new NextRequest(`http://localhost/api/actions/${id}/${verb}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}
const confirm = (id: string, s: string) => postAction(confirmPost, id, s, 'confirm');
const recover = (id: string, s: string) => postAction(recoverPost, id, s, 'recover');

/** Park a STANDALONE (no plan link) `transfer_money` and return its `PendingAction` id. */
async function parkTransfer(sessionId: string, amount: number): Promise<string> {
  const gated = await executeGatedTool({
    sessionId,
    userId,
    toolName: 'transfer_money',
    args: { name: '张伟', amount },
    userRequest: `给张伟转${amount}元`,
  });
  expect(gated.ok).toBe(false);
  expect(gated.requiresConfirmation).toBe(true);
  const id = gated.pendingActionId;
  expect(id).toBeTruthy();
  return id!;
}

/** The REAL fault injection: the NEXT result+status transaction genuinely rolls back. */
function wedgeResultTransaction() {
  return vi
    .spyOn(pendingActionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('review: result transaction failed'));
}

/**
 * The REAL critical-fault injection: make the EXECUTION audit insert (`dedupeKey === exec:<id>`)
 * throw ONCE, so the atomic settle `$transaction` genuinely rolls back. Every OTHER audit write
 * (i.e. without that exact dedupe key) delegates to the saved original.
 */
function failExecutionAuditOnce(id: string) {
  const original = auditStore.insertAuditLog.bind(auditStore);
  let injected = 0;
  const spy = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey === `exec:${id}` && injected === 0) {
      injected++;
      throw new Error('review: critical execution audit insert failed');
    }
    return original(entry, opts);
  });
  return { spy, fired: () => injected, calls: () => spy.mock.calls.length };
}

const debitRows = (amount: number) =>
  getTestPrisma().transaction.count({
    where: { userId, amount: -amount, counterpartyId: 'contact_zhangwei' },
  });
/** The execution audit row for an action is uniquely identified by its `dedupeKey`. */
const executionAudits = (id: string) =>
  getTestPrisma().auditLog.count({ where: { dedupeKey: `exec:${id}` } });
/** The committed execution receipt for a STANDALONE action is keyed by the action id. */
const receiptCount = (id: string) =>
  getTestPrisma().executionReceipt.count({ where: { userId, key: id } });
const checkingBalance = async () =>
  (await getTestPrisma().account.findFirst({ where: { userId, type: 'CHECKING' } }))?.balance;

it('a CRITICAL execution-audit insert failure ROLLS BACK the atomic settle (SDK side effect still commits exactly once)', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkTransfer(s, 200);
  expect(await debitRows(200)).toBe(0);

  // Make the execution-audit insert (dedupeKey `exec:<id>`) throw ONCE.
  const fault = failExecutionAuditOnce(id);
  const first = await confirm(id, s);
  expect(fault.fired()).toBeGreaterThanOrEqual(1); // the injection FIRED
  expect(fault.calls()).toBeGreaterThanOrEqual(1);

  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  // The audit failure rolled the ATOMIC settle back: the row is NOT `executed`, no result landed.
  expect(first.status).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();

  // …while the SDK side effect that committed BEFORE the settle stays committed EXACTLY ONCE.
  expect(await debitRows(200)).toBe(1);
  expect(await checkingBalance()).toBe(CHECKING_BALANCE - 200);
  expect(await receiptCount(id)).toBe(1);
  expect(await executionAudits(id)).toBe(0); // the audit insert was rolled back with the settle

  // Restore the real audit write and RECOVER: the settle lands, and the audit is backfilled.
  fault.spy.mockRestore();
  const recovered = await recover(id, s);
  const after = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audits = await executionAudits(id);
  const debits = await debitRows(200);

  console.log(
    'REVIEW_AUDIT_ROLLBACK',
    JSON.stringify({
      injected: fault.fired(),
      firstHttp: first.status,
      wedgedStatus: wedged.status,
      wedgedResultNull: wedged.resultJson === null,
      receiptAfterFault: 1,
      auditsAfterFault: 0,
      recoveryOk: recovered.body.data?.ok,
      recoveredStatus: after.status,
      recoveredResultOk: after.resultJson ? JSON.parse(after.resultJson).ok : null,
      auditsAfterRecovery: audits,
      debitsAfterRecovery: debits,
    }),
  );

  expect(recovered.status).toBe(200);
  expect(recovered.body.data?.ok).toBe(true);
  expect(after.status).toBe('executed');
  expect(after.resultJson ? JSON.parse(after.resultJson).ok : null).toBe(true);
  expect(audits).toBe(1); // exactly ONE execution audit — backfilled by the recovery
  expect(debits).toBe(1); // STILL exactly one debit — the recovery never re-ran the tool
  expect(await checkingBalance()).toBe(CHECKING_BALANCE - 200);
});

it('a HISTORICAL already-posted but missing-audit row is idempotently BACKFILLED on recovery (never failed, no second debit)', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkTransfer(s, 200);

  // Build the committed WEDGE: the SDK side effect commits, but the result+status transaction
  // genuinely rolls back — so NO execution audit row is ever written for this action.
  const wedge = wedgeResultTransaction();
  const first = await confirm(id, s);
  expect(wedge.mock.calls.length).toBe(1); // the injection HIT the result transaction
  wedge.mockRestore();

  const wedged = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  expect(first.status).toBe(500);
  expect(wedged.status).toBe('confirmed');
  expect(wedged.resultJson).toBeNull();
  expect(await receiptCount(id)).toBe(1); // the side effect DID commit (receipt present)
  expect(await debitRows(200)).toBe(1);

  // Simulate a LEGACY/pre-upgrade row whose side effect posted without an audit: ensure the
  // execution audit is genuinely absent before recovery.
  const deleted = await p.auditLog.deleteMany({ where: { dedupeKey: `exec:${id}` } });
  expect(deleted.count).toBe(0); // the rolled-back settle never wrote one — the state IS "missing audit"
  expect(await executionAudits(id)).toBe(0);

  // RECOVERY backfills the missing execution audit from the committed receipt.
  const recovered1 = await recover(id, s);
  const after1 = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audit1 = await executionAudits(id);
  const debit1 = await debitRows(200);

  expect(recovered1.status).toBe(200);
  expect(recovered1.body.data?.status).toBe('executed');
  expect(after1.status).toBe('executed'); // NEVER `failed`
  expect(audit1).toBe(1); // the missing audit row was BACKFILLED exactly once
  expect(debit1).toBe(1);
  expect(await receiptCount(id)).toBe(1);

  // A REPEAT recovery adds NO second audit and NO second debit.
  const recovered2 = await recover(id, s);
  const after2 = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audit2 = await executionAudits(id);
  const debit2 = await debitRows(200);

  console.log(
    'REVIEW_AUDIT_BACKFILL',
    JSON.stringify({
      missingBefore: 0,
      deletedByCleanup: deleted.count,
      recoveryStatus: recovered1.body.data?.status,
      actionAfterRecovery: after1.status,
      auditsAfterRecovery: audit1,
      debitsAfterRecovery: debit1,
      repeatStatus: recovered2.body.data?.status,
      actionAfterRepeat: after2.status,
      auditsAfterRepeat: audit2,
      debitsAfterRepeat: debit2,
    }),
  );

  expect(recovered2.status).toBe(200);
  expect(recovered2.body.data?.status).toBe('executed');
  expect(after2.status).toBe('executed');
  expect(audit2).toBe(audit1); // NO second execution audit
  expect(debit2).toBe(debit1); // NO second debit
});

it('a repeat recovery is idempotent — exactly ONE execution audit and ONE debit, never downgraded', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const id = await parkTransfer(s, 200);

  const wedge = wedgeResultTransaction();
  const first = await confirm(id, s);
  expect(wedge.mock.calls.length).toBe(1); // the injection HIT the target
  wedge.mockRestore();

  // Recovery #1 — the legitimate settlement of the wedge.
  const rec1 = await recover(id, s);
  const after1 = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audit1 = await executionAudits(id);
  const debit1 = await debitRows(200);
  const balance1 = await checkingBalance();

  // Recovery #2 — the SAME entry point again (a repeat click / a refresh-driven recovery).
  const rec2 = await recover(id, s);
  const after2 = await p.pendingAction.findUniqueOrThrow({ where: { id } });
  const audit2 = await executionAudits(id);
  const debit2 = await debitRows(200);
  const balance2 = await checkingBalance();

  console.log(
    'REVIEW_AUDIT_REPEAT_IDEMPOTENT',
    JSON.stringify({
      rec1Ok: rec1.body.data?.ok,
      status1: after1.status,
      audit1,
      debit1,
      balance1,
      rec2Ok: rec2.body.data?.ok,
      rec2Status: rec2.body.data?.status,
      status2: after2.status,
      audit2,
      debit2,
      balance2,
    }),
  );

  expect(rec1.status).toBe(200);
  expect(rec1.body.data?.ok).toBe(true);
  expect(after1.status).toBe('executed');
  expect(audit1).toBe(1);
  expect(debit1).toBe(1);
  expect(balance1).toBe(CHECKING_BALANCE - 200);

  expect(rec2.status).toBe(200);
  expect(rec2.body.data?.status).toBe('executed'); // reports the persisted status truthfully
  expect(after2.status).toBe('executed'); // never downgraded
  expect(audit2).toBe(1);
  expect(audit2).toBe(audit1); // no second execution audit
  expect(debit2).toBe(1);
  expect(debit2).toBe(debit1); // no second debit
  expect(balance2).toBe(balance1); // balance stable
});
