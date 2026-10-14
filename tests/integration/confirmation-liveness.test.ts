/**
 * integration/confirmation-liveness.test.ts — DEFECT 2: the LIVE-confirmation
 * REFERENCE-COUNT marker lifecycle (`agent/confirmation-recovery.ts`).
 *
 * `confirmAction`/`verifyAction` mark a gated action LIVE in an in-process REFERENCE-COUNTED registry
 * (`retainAction`/`releaseAction`/`isActionLive`, wired via `withLiveConfirmation` in
 * `agent/confirmation.ts`) for the WHOLE duration of the continuation, and drop the marker in a
 * `finally`. The registry must be a COUNT, not a `Set`:
 *
 *  (a) a rejected DUPLICATE verify of the SAME action must NOT clear the FIRST still-live
 *      continuation's marker, so a concurrent plan re-run DEFERS to the live continuation instead of
 *      mis-finalizing the result-less `confirmed` row;
 *  (b) an ABNORMAL EXIT (a thrown error inside the gated execution) must still release the liveness
 *      bookkeeping, so a LATER legitimate recovery of the wedged `confirmed` row still makes progress;
 *  (c) the final PendingAction / node / plan / API-response states are mutually CONSISTENT.
 *
 * Only the frozen reference `tests/integration/confirmation-continuation.test.ts` covers the YELLOW confirm case;
 * this spec uses the RED / MFA `verify` path. REAL route handlers + REAL isolated `prisma/test.db`.
 * Mocks are used ONLY as barriers (`authorizeAction` spy) or REAL fault injection
 * (`setPendingActionStatus` throw) — never to fabricate a return value.
 */
import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan } from '@/agent/tools/planning';
import * as pendingActionRepo from '@/lib/db/repositories/pendingAction';
import { securityGateway } from '@/security/security-gateway';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { GET as actionsGet } from '@/app/api/actions/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { centsToMoney } from '@/lib/money';

const userId = 'user_liming';
/** A RED transfer (> ¥1000 ⇒ RED ⇒ parked `awaiting_mfa`). */
const RED_TRANSFER = { name: '张伟', amount: '5000' } as const;

beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
async function bounded(p: Promise<unknown>) {
  let timer: any;
  try {
    await Promise.race([
      p,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const runner = (s: string) => (toolName: string, args: Record<string, unknown>, ctx?: { taskId?: string; nodeId?: string }) =>
  executeGatedTool({ sessionId: s, userId, toolName: toolName as any, args, userRequest: '核查人工确认活性标记', taskId: ctx?.taskId, nodeId: ctx?.nodeId });

async function task(id: string, action: string, s: string) {
  const res = await taskPost(
    new NextRequest(`http://localhost/api/tasks/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  );
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.data;
}
async function verifyRaw(id: string, s: string, code: string) {
  const res = await verifyPost(
    new NextRequest(`http://localhost/api/actions/${id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` },
      body: JSON.stringify({ code }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}

/** Seed a single-node plan whose gated RED `transfer_money` node parks an `awaiting_mfa` action. */
async function seedRedTransferPlan(s: string) {
  const p = getTestPrisma();
  const seeded = await runSubmitPlan(
    userId,
    {
      goal: '高风险转账人工确认',
      nodes: [{ id: 'pay', name: '大额转账', kind: 'tool', tool: 'transfer_money', args: RED_TRANSFER, dependencies: [] }],
    },
    { sessionId: s, runTool: runner(s) },
  );
  const plan: any = seeded.data;
  const action = (await p.pendingAction.findFirst({ where: { sessionId: s } }))!;
  return { plan, action };
}
/** Plan + its single node, re-read from persisted state. */
async function readPlan(planId: string) {
  return getTestPrisma().agentTask.findUnique({ where: { id: planId }, include: { nodes: true } });
}
const debitCount = () =>
  getTestPrisma().transaction.count({ where: { userId, counterpartyId: 'contact_zhangwei', amountMinor: -500000n } });
const balance = async () => centsToMoney((await getTestPrisma().account.findFirstOrThrow({ where: { userId, type: 'CHECKING' } })).balanceMinor);

describe('[integration] live-confirmation REFERENCE-COUNT marker lifecycle', () => {
  it('(a) a rejected duplicate verify must not clear the first still-live continuation marker', async () => {
    const s = (await getDemoSession(userId)).sessionId;
    const p = getTestPrisma();
    const { plan, action } = await seedRedTransferPlan(s);
    expect(action.status).toBe('awaiting_mfa');
    const before = await debitCount();

    // REAL barrier: hold the FIRST verify AFTER the gateway claimed the row (`confirmed`) but BEFORE
    // its side effect is applied, so a duplicate + a plan re-run observe the live in-flight window.
    const reached = deferred();
    const release = deferred();
    const original = securityGateway.authorizeAction.bind(securityGateway);
    let held = false;
    const spy = vi.spyOn(securityGateway, 'authorizeAction').mockImplementation(async (id, opts) => {
      const value = await original(id, opts);
      if (value.ok && !held) {
        held = true;
        reached.release();
        await release.promise;
      }
      return value;
    });

    const firstRun = verifyRaw(action.id, s, '123456');
    let second: any, resumed: any, during: any, first: any;
    let authCalls = 0;
    try {
      await bounded(reached.promise);
      // Duplicate verify with the SAME (already-verified) code → gateway exactly-once CAS → CONFLICT.
      second = await verifyRaw(action.id, s, '123456');
      // A concurrent plan re-run must DEFER to the live continuation, not finalize the row.
      resumed = await task(plan.id, 'resume', s);
      authCalls = spy.mock.calls.length;
      during = await p.pendingAction.findUnique({ where: { id: action.id } });
    } finally {
      release.release();
      first = await firstRun;
      spy.mockRestore();
    }

    const after = await readPlan(plan.id);
    const afterAction = await p.pendingAction.findUnique({ where: { id: action.id } });
    console.log(
      'REVIEW_CONFIRMATION_MARKER_DUPLICATE',
      JSON.stringify({
        duplicateHttp: second?.status,
        duplicateOk: second?.body?.data?.ok,
        duplicateStatus: second?.body?.data?.status,
        duringStatus: during?.status,
        duringResult: during?.resultJson,
        resumedStatus: resumed?.status,
        firstOk: first?.body?.data?.ok,
        firstStatus: first?.body?.data?.status,
        afterAction: afterAction?.status,
        finalPlan: after?.status,
        finalNode: after?.nodes[0]?.status,
        authCalls,
        balance: await balance(),
        debits: await debitCount(),
      }),
    );

    // WEDGED pre-release state: the row is `confirmed` with no result yet, the re-run deferred.
    expect(during?.status).toBe('confirmed');
    expect(during?.resultJson).toBeNull();
    expect(second.body.data?.ok).toBe(false);
    expect(authCalls).toBeGreaterThanOrEqual(2);
    expect(resumed.status).toBe('waiting_confirmation');
    // The FIRST continuation still owned the marker, so it finished normally.
    expect(first.body.data?.ok).toBe(true);
    expect(afterAction?.status).toBe('executed');
    expect(after?.nodes[0]?.status).toBe('success');
    expect(after?.status).toBe('success');
    // Side effect exactly once.
    expect(await balance()).toBe('18580.00');
    expect(await debitCount()).toBe(before + 1);
  });

  it('(b) an abnormal exit must release the liveness bookkeeping so a later recovery progresses', async () => {
    const s = (await getDemoSession(userId)).sessionId;
    const p = getTestPrisma();
    const { plan, action } = await seedRedTransferPlan(s);
    expect(action.status).toBe('awaiting_mfa');
    const before = await debitCount();

    // REAL fault injection: make the atomic result+status transaction REJECT, so the continuation
    // exits abnormally (the side effect commits; the result+status write rolls back).
    const spy = vi.spyOn(pendingActionRepo, 'setPendingActionStatus').mockRejectedValueOnce(new Error('review: result transaction failed'));
    const failedVerify = await verifyRaw(action.id, s, '123456');
    const injectionCalls = spy.mock.calls.length;
    spy.mockRestore();

    // The injection actually HIT the real path (abnormal exit ⇒ 500).
    expect(injectionCalls).toBeGreaterThanOrEqual(1);
    expect(failedVerify.status).toBe(500);

    // WEDGED pre-recovery state, captured BEFORE any recovery.
    const wedged = await p.pendingAction.findUnique({ where: { id: action.id } });
    const wedgedPlan = await readPlan(plan.id);
    expect(wedged?.status).toBe('confirmed');
    expect(wedged?.resultJson).toBeNull();
    expect(['waiting_confirmation', 'waiting_verification']).toContain(wedgedPlan?.nodes[0]?.status);
    expect(wedgedPlan?.status).toBe('waiting_confirmation');

    // A LATER legitimate recovery must still work (the marker was released in the `finally`).
    const resumed = await task(plan.id, 'resume', s);
    const recovered = await readPlan(plan.id);
    const recoveredAction = await p.pendingAction.findUnique({ where: { id: action.id } });
    console.log(
      'REVIEW_CONFIRMATION_MARKER_ABNORMAL_EXIT',
      JSON.stringify({
        failedVerifyHttp: failedVerify.status,
        injectionCalls,
        wedgedStatus: wedged?.status,
        wedgedResult: wedged?.resultJson,
        wedgedPlan: wedgedPlan?.status,
        resumedStatus: resumed.status,
        recoveredPlan: recovered?.status,
        recoveredNode: recovered?.nodes[0]?.status,
        recoveredAction: recoveredAction?.status,
        recoveredError: recovered?.nodes[0]?.error,
        balance: await balance(),
        debits: await debitCount(),
      }),
    );

    // Recovery MAKES PROGRESS: the plan no longer dangles `waiting_confirmation` forever.
    expect(resumed.status).not.toBe('waiting_confirmation');
    // A committed ExecutionReceipt (the debit, the ledger row and the receipt are written in ONE tx)
    // means the wedged action converges to executed / node+plan success; the tool is NEVER re-invoked
    // and the committed side effect is never fabricated into a failed / 人工核对 outcome.
    expect(recovered?.status).toBe('success');
    expect(recovered?.nodes[0]?.status).toBe('success');
    expect(recoveredAction?.status).toBe('executed');
    // The tool was NEVER re-invoked: side effect still exactly once.
    expect(await balance()).toBe('18580.00');
    expect(await debitCount()).toBe(before + 1);
  });

  it('(c) final PendingAction / node / plan / API-response states are all consistent', async () => {
    const s = (await getDemoSession(userId)).sessionId;
    const p = getTestPrisma();
    const { plan, action } = await seedRedTransferPlan(s);
    const before = await debitCount();

    const res = await verifyRaw(action.id, s, '123456');
    const dbAction = await p.pendingAction.findUnique({ where: { id: action.id } });
    const dbPlan = await readPlan(plan.id);
    const listedResponse = await actionsGet(new NextRequest('http://localhost/api/actions', { headers: { cookie: `banking_session=${s}` } }));
    const listed = await listedResponse.json();
    console.log(
      'REVIEW_CONFIRMATION_MARKER_CONSISTENCY',
      JSON.stringify({
        http: res.status,
        responseOk: res.body.data?.ok,
        responseStatus: res.body.data?.status,
        responseTier: res.body.data?.tier,
        responseRequiresMfa: res.body.data?.requiresMfa,
        responseMfaResult: res.body.data?.mfaResult,
        dbAction: dbAction?.status,
        dbPlan: dbPlan?.status,
        dbNode: dbPlan?.nodes[0]?.status,
        listed: listed.data?.length,
        balance: await balance(),
        debits: await debitCount(),
      }),
    );

    // HTTP status/ok agree with the DB row; action/node/plan agree with the response.
    expect(res.status).toBe(200);
    expect(res.body.data?.ok).toBe(true);
    expect(res.body.data?.status).toBe('executed');
    expect(res.body.data?.tier).toBe('RED');
    expect(res.body.data?.requiresMfa).toBe(true);
    expect(res.body.data?.mfaResult).toBe('success');
    expect(dbAction?.status).toBe(res.body.data?.status);
    expect(dbPlan?.nodes[0]?.status).toBe('success');
    expect(dbPlan?.status).toBe('success');
    // A settled gated action is no longer surfaced for a human decision.
    expect(listed.data?.length).toBe(0);
    expect(await balance()).toBe('18580.00');
    expect(await debitCount()).toBe(before + 1);
  });
});
