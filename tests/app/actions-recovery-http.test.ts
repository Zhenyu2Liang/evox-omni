/**
 * tests/app/actions-recovery-http.test.ts — REAL-application-entry (HTTP) integration for the
 * STANDALONE, REFRESH-REACHABLE recovery surface (`/actions` → `GET /api/actions` +
 * `POST /api/actions/[id]/recover`).
 *
 * WHY: after a browser refresh or a service restart the user must be able to FIND and SETTLE the
 * operations that still need their attention WITHOUT knowing the hidden `actionId` and WITHOUT
 * re-sending anything. `GET /api/actions` is that discovery surface; `POST /api/actions/[id]/recover`
 * is the single recovery entry point behind the new `/actions` page. This spec pins down BOTH parts
 * of the requirement, for STANDALONE wedges AND for PLAN-LINKED (plan-node) wedges:
 *   - a standalone `transfer_money` wedge is SURFACED with `attention: 'recoverable'` and the recover
 *     route replays it idempotently to the terminal `executed` (side effect EXACTLY once);
 *   - a plan-node wedge is SURFACED with an actionable (non-`processing`) attention class and the
 *     recover route RESUMES the owning plan server-side (the client never needs plan knowledge), so
 *     the plan/node settle WITHOUT the tool being re-invoked and WITHOUT the plan being left
 *     `waiting_confirmation`.
 *
 * Real app-entry layer: the REAL Next.js route handlers, the REAL confirmation continuation, the REAL
 * Banking SDK and the REAL isolated test SQLite run in-process; the only "fault" is REAL injection
 * (`vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(...)`) that makes the
 * result+status transaction genuinely roll back after the SDK side effect committed. Every assertion
 * re-reads persisted DB state.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as actionsGet } from '@/app/api/actions/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as recoverPost } from '@/app/api/actions/[id]/recover/route';
import { executeGatedTool } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import type { PendingActionStatus } from '@/lib/contracts/security';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { actionUrl, getJson, idCtx, postJson, type HttpResult } from './harness';
import { banking } from '@/banking-sdk';

const RECIPIENT_NAME = '张伟';
/** Seeded 活期 balance (¥23,580): −200 after the wedged transfer's committed side effect. */
import { centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';
const SEEDED_BALANCE = '23580.00';
const TRANSFER_AMOUNT = '200';
const EXPECTED_BALANCE_AFTER = subtractMoney(SEEDED_BALANCE, TRANSFER_AMOUNT);

/** The route envelope (structural transport shape; NOT a frozen contract type). */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** A surfaced row as `GET /api/actions` returns it (only the fields this spec asserts). */
interface SurfacedRow {
  id: string;
  status: PendingActionStatus;
  attention: string;
}

/** Success protocol helper: assert the envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/** Run one `POST` body through a `/…/[id]` route handler with the cookie identity. */
async function idPost(handler: typeof recoverPost, basePath: string, id: string, sessionId: string) {
  const res = await postJson<Envelope<unknown>>(handler, basePath, {}, { ctx: idCtx(id), sessionId });
  return res;
}

/** `POST /api/actions/[id]/confirm` — the human confirmation that triggers the (faulted) continuation. */
const confirmWith = (id: string, sessionId: string) =>
  idPost(confirmPost as typeof recoverPost, `/api/actions/${id}/confirm`, id, sessionId);

/** `POST /api/actions/[id]/recover` — the refresh-reachable recovery entry point. */
const recoverWith = (id: string, sessionId: string) =>
  postJson<Envelope<Record<string, unknown>>>(recoverPost, actionUrl(id, 'recover'), {}, {
    ctx: idCtx(id),
    sessionId,
  });

/** `GET /api/actions` — the page-refresh discovery path behind `/actions`. */
async function listActions(sessionId: string): Promise<{ status: number; rows: SurfacedRow[] }> {
  const res = await getJson<Envelope<SurfacedRow[]>>(actionsGet, '/api/actions', { sessionId });
  if (!res.data?.ok) return { status: res.status, rows: [] };
  return { status: res.status, rows: res.data.data ?? [] };
}

/** The REAL fault injection: make the NEXT result+status transaction genuinely roll back. */
const wedgeResultTransaction = () =>
  vi
    .spyOn(pendingActionRepo, 'setPendingActionStatus')
    .mockRejectedValueOnce(new Error('http-recovery: result+status transaction rolled back'));

/** Load the canonical demo session used by the HTTP entry. */
async function newSessionId(): Promise<string> {
  return (await getDemoSession(DEMO_USER_ID)).sessionId;
}

/** The gateway-authorized per-node runner — MUST forward the node identity (the plan LINK). */
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

/** The number of committed −200 debits to the seeded recipient (the side-effect counter). */
function debitCount(): Promise<number> {
  return getTestPrisma().transaction.count({
    where: { userId: DEMO_USER_ID, amountMinor: -moneyToCents(TRANSFER_AMOUNT), counterpartyId: 'contact_zhangwei' },
  });
}

/** The seeded 活期 account's CURRENT balance. */
async function checkingBalance(): Promise<string> {
  const account = await getTestPrisma().account.findFirstOrThrow({
    where: { userId: DEMO_USER_ID, type: 'CHECKING' },
  });
  return centsToMoney(account.balanceMinor);
}

/** The persisted `PendingAction` row (throws when absent — a missing action is a bug). */
function actionRow(actionId: string) {
  return getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: actionId } });
}

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

describe('standalone /actions recovery surface', () => {
  it('surfaces a standalone wedge as `recoverable` and recovers it to `executed` (side effect once)', async () => {
    const sessionId = await newSessionId();

    // Park a YELLOW transfer (standalone: no plan/node link).
    const gated = await executeGatedTool({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: 'transfer_money',
      args: { name: RECIPIENT_NAME, amount: TRANSFER_AMOUNT },
      userRequest: '给张伟转200元',
    });
    expect(gated.ok).toBe(false);
    expect(gated.requiresConfirmation).toBe(true);
    const actionId = gated.pendingActionId!;
    expect(actionId).toBeTruthy();

    // Confirm, but fault the atomic result+status write: the SDK side effect COMMITS, the row wedges.
    const spy = wedgeResultTransaction();
    const first = await confirmWith(actionId, sessionId);
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();

    const wedged = await actionRow(actionId);
    expect(wedged.status).toBe('confirmed');
    expect(wedged.resultJson).toBeNull();
    expect(await debitCount()).toBe(1);
    expect(await checkingBalance()).toBe(EXPECTED_BALANCE_AFTER);

    // DISCOVERY: a plain refresh of `/actions` finds the wedge as `recoverable`.
    const listed = await listActions(sessionId);
    expect(listed.status).toBe(200);
    const surfaced = listed.rows.find((row) => row.id === actionId);
    expect(surfaced, `GET /api/actions did not surface ${actionId}`).toBeDefined();
    expect(surfaced!.attention).toBe('recoverable');

    // RECOVERY: the refresh-reachable entry point settles it without the user knowing the id.
    const recovered = await recoverWith(actionId, sessionId);
    expect(recovered.status).toBe(200);
    const outcome = payload<{ ok: boolean; status: string; actionId: string }>(
      recovered as HttpResult<Envelope<{ ok: boolean; status: string; actionId: string }>>,
    );
    expect(outcome.actionId).toBe(actionId);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    // The TRUE persisted outcome: terminal `executed`, a stored result, exactly ONE side effect.
    const settled = await actionRow(actionId);
    expect(settled.status).toBe('executed');
    expect(settled.resultJson).not.toBeNull();
    expect(await debitCount()).toBe(1);
    expect(await checkingBalance()).toBe(EXPECTED_BALANCE_AFTER);

    // A terminal row needs no attention → the surface hides it (no stale entry after recovery).
    const after = await listActions(sessionId);
    expect(after.rows.map((row) => row.id)).not.toContain(actionId);
  });

  it('surfaces a plan-node wedge with an actionable attention and recovers it by resuming the plan', async () => {
    const sessionId = await newSessionId();
    const prisma = getTestPrisma();

    // Seed a durable plan whose single node parks a gated `set_card_limit` (YELLOW).
    const card = await prisma.card.findFirstOrThrow({ where: { userId: DEMO_USER_ID, type: 'CREDIT' } });
    const seeded = await runSubmitPlan(
      DEMO_USER_ID,
      {
        goal: '计划楔子恢复',
        nodes: [
          {
            id: 'limit',
            name: '调整限额',
            kind: 'tool',
            tool: 'set_card_limit',
            args: { cardId: card.id, category: '娱乐', amount: '1500' },
            dependencies: [],
          },
        ],
      },
      { sessionId, runTool: gatewayRunTool(sessionId, '计划楔子恢复') },
    );
    expect(seeded.ok, `runSubmitPlan produced no plan: ${seeded.error}`).toBe(true);
    const planId = (seeded.data as { id: string }).id;

    const action = await prisma.pendingAction.findFirstOrThrow({ where: { sessionId } });
    expect(action.taskId).toBe(planId);
    expect(action.nodeId).toBe('limit');

    // Confirm, but fault the atomic result+status write → the plan-node action wedges.
    const businessWrite = vi.spyOn(banking.card, 'setCardLimit');
    const spy = wedgeResultTransaction();
    await confirmWith(action.id, sessionId);
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();

    const wedged = await actionRow(action.id);
    expect(wedged.status).toBe('confirmed');
    expect(wedged.resultJson).toBeNull();
    expect(businessWrite).toHaveBeenCalledTimes(1);
    const receipt = await prisma.executionReceipt.findFirstOrThrow({ where: { userId: DEMO_USER_ID, toolName: 'set_card_limit' } });
    expect(JSON.parse(receipt.responseJson ?? '{}').ok).toBe(true);
    expect((await prisma.cardLimit.findFirstOrThrow({ where: { cardId: card.id, category: '\u5a31\u4e50' } })).amountMinor).toBe(150_000n);

    // DISCOVERY: the plan-linked wedge is surfaced with an actionable attention class — never
    // `processing` (no live lease) — so `/actions` can offer the recovery action after a refresh.
    const listed = await listActions(sessionId);
    expect(listed.status).toBe(200);
    const surfaced = listed.rows.find((row) => row.id === action.id);
    expect(surfaced, `GET /api/actions did not surface plan-linked ${action.id}`).toBeDefined();
    expect(['recoverable', 'reconciliation']).toContain(surfaced!.attention);

    // RECOVERY: the SAME refresh-reachable entry point resumes the OWNING PLAN server-side.
    const recovered = await recoverWith(action.id, sessionId);
    expect(recovered.status).toBe(200);
    const outcome = payload<{ ok: boolean; actionId: string; events?: unknown[] }>(
      recovered as HttpResult<Envelope<{ ok: boolean; actionId: string; events?: unknown[] }>>,
    );
    expect(outcome.actionId).toBe(action.id);
    // The atomic receipt proves the commit independently of the failed action-status landing.
    expect(outcome.ok).toBe(true);
    expect(businessWrite).toHaveBeenCalledTimes(1);

    // The plan (and its node) settle TERMINALLY — never left `waiting_confirmation`, and the tool is
    // NEVER re-invoked (the persisted action is no longer `confirmed`).
    const plan = await prisma.agentTask.findUniqueOrThrow({ where: { id: planId } });
    const node = await prisma.agentTaskNode.findFirstOrThrow({ where: { taskId: planId, nodeId: 'limit' } });
    const settled = await actionRow(action.id);

    expect(plan.status).toBe('success');
    expect(node.status).toBe('success');
    expect(settled.status).toBe('executed');
    expect(settled.status).not.toBe('confirmed');

    // Idempotent, honest recovery: a REPEAT recover is a settled no-op (no duplicate side effect,
    // no fresh confirmation, the plan stays terminal).
    const repeated = await recoverWith(action.id, sessionId);
    expect(repeated.status).toBe(200);
    const planAfter = await prisma.agentTask.findUniqueOrThrow({ where: { id: planId } });
    const nodeAfter = await prisma.agentTaskNode.findFirstOrThrow({
      where: { taskId: planId, nodeId: 'limit' },
    });
    expect(planAfter.status).toBe(plan.status);
    expect(nodeAfter.status).toBe(node.status);
    expect(businessWrite).toHaveBeenCalledTimes(1);
    expect(await prisma.cardLimit.count({ where: { cardId: card.id, category: '娱乐' } })).toBeLessThanOrEqual(1);
  });
});
