/**
 * agentRun.locked-settlement.test.ts — DB-backed unit spec for the `locked` TERMINAL
 * `PendingAction` status settling its linked `ToolInvocation`.
 *
 * A locked operation (exhausted MFA attempts / open circuit) is a SETTLED refusal: the gateway
 * CASes `PendingAction.status` to the terminal `'locked'`, and it is never re-prompted, never
 * resumed and never a legal claim source. Before this spec's subject was fixed, the run repository
 * enumerated settled action statuses WITHOUT `'locked'`, so:
 *
 *   - `synchronizeRunActionInvocations` never settled the linked invocation (it stayed
 *     `waiting_verification` forever), and
 *   - `finalizeReceiptedAgentRun` bailed out on its "every invocation is terminal" guard forever,
 *     leaving the run unusable.
 *
 * The spec pins the honest outcome: the invocation ends `failed` with `errorCode = 'MFA_LOCKED'`
 * (a refusal, NOT `needs_reconciliation`, whose outcome would be unknown), and a run whose only
 * outstanding work is the locked action finalizes as `failed`.
 *
 * Runs under the ROOT `vitest.config.ts` against the REAL test SQLite
 * (`tests/helpers/db` + `tests/helpers/fixtures`); the shared DB is reset+seeded per test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { newId } from '@/lib/ids';
import {
  beginAgentRun,
  finalizeReceiptedAgentRun,
  finishAgentRun,
  finishInvocationWithEvent,
  startInvocationWithEvent,
  synchronizeRunActionInvocations,
  updateInvocationAuthorization,
} from '@/lib/db/repositories/agentRun';
import { createSession } from '@/lib/db/repositories/session';
import { claimPendingActionLease, createPendingAction } from '@/lib/db/repositories/pendingAction';
import {
  OPEN_PENDING_ACTION_STATUSES,
  SETTLED_PENDING_ACTION_STATUSES,
  TERMINAL_PENDING_ACTION_STATUSES,
} from '@/lib/contracts/security';

/** The confirmation-card summary persisted on each seeded action. */
const SUMMARY = {
  title: 'Transfer',
  toolName: 'transfer_money' as const,
  tier: 'YELLOW' as const,
  fields: [] as Array<{ label: string; value: string }>,
  requiresMfa: true,
};

const STARTED_EVENT = { channel: 'internal' as const, eventType: 'invocation_started', payloadJson: '{}' };

/**
 * Seed one admitted run on a fresh session plus a single invocation parked in
 * `waiting_verification` — the state a gated write leaves behind while the user is asked for a
 * verification code. The run is then closed as `interrupted` so the finalizer's "not a running
 * run" guard is satisfied without touching the parked invocation.
 */
async function seedVerifyingRun() {
  const session = await createSession({ userId: DEMO_USER_ID, stateJson: '{"transcript":[]}' });
  const begun = await beginAgentRun({
    sessionId: session.id,
    userId: DEMO_USER_ID,
    requestDigest: 'locked-settlement-digest',
    requestJson: '{}',
  });
  if (!begun.lease) throw new Error('beginAgentRun did not admit a run');
  const lease = begun.lease;
  const invocationId = newId('inv');
  await startInvocationWithEvent(
    lease,
    {
      id: invocationId,
      callId: 'call_locked',
      toolName: 'transfer_money',
      argsJson: '{"amount":"200.00"}',
      requestDigest: 'call_locked_digest',
      policy: { safety: 'reconcile_only', maxAttempts: 1 },
    },
    STARTED_EVENT,
  );
  await updateInvocationAuthorization(lease, invocationId, 'waiting_verification');
  return { session, run: begun.run, lease, invocationId };
}

/** Persist the action the gateway CASes to `'locked'` once the MFA attempt limit is exhausted. */
function seedLinkedAction(
  sessionId: string,
  invocationId: string,
  status: 'locked' | 'pending',
): Promise<{ id: string }> {
  return createPendingAction({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { name: 'Zhang Wei', amount: '200.00' },
    tier: 'YELLOW',
    requiresMfa: true,
    summary: SUMMARY,
    status,
    invocationId,
  });
}
describe('a locked PendingAction settles its linked ToolInvocation', () => {
  beforeEach(resetDatabase, 30000);
  afterAll(disconnectTestPrisma, 30000);

  it('synchronizeRunActionInvocations fails the parked invocation with MFA_LOCKED', async () => {
    const { session, run, lease, invocationId } = await seedVerifyingRun();
    const action = await seedLinkedAction(session.id, invocationId, 'locked');
    await finishAgentRun(lease, 'interrupted');

    await synchronizeRunActionInvocations(run.id, session.id, DEMO_USER_ID);

    const invocation = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
    expect(invocation.status).toBe('failed');
    expect(invocation.errorCode).toBe('MFA_LOCKED');
    expect(invocation.finishedAt).toBeInstanceOf(Date);
    // A locked refusal is a KNOWN refusal, never an unknown outcome.
    expect(invocation.status).not.toBe('needs_reconciliation');

    const events = await getTestPrisma().agentRunEvent.findMany({
      where: { runId: run.id, eventType: 'invocation_settled_from_action' },
    });
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payloadJson)).toMatchObject({
      invocationId,
      actionId: action.id,
      status: 'failed',
      errorCode: 'MFA_LOCKED',
    });
  });

  it('is idempotent — a second synchronization rewrites neither the invocation nor an event', async () => {
    const { session, run, lease, invocationId } = await seedVerifyingRun();
    await seedLinkedAction(session.id, invocationId, 'locked');
    await finishAgentRun(lease, 'interrupted');

    await synchronizeRunActionInvocations(run.id, session.id, DEMO_USER_ID);
    const settled = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });

    await synchronizeRunActionInvocations(run.id, session.id, DEMO_USER_ID);

    const again = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
    expect(again.status).toBe(settled.status);
    expect(again.errorCode).toBe('MFA_LOCKED');
    expect(again.finishedAt?.getTime()).toBe(settled.finishedAt?.getTime());
    expect(
      await getTestPrisma().agentRunEvent.count({ where: { runId: run.id, eventType: 'invocation_settled_from_action' } }),
    ).toBe(1);
  });

  it('finalizeReceiptedAgentRun settles the run as failed / MFA_LOCKED instead of returning forever', async () => {
    const { session, run, lease, invocationId } = await seedVerifyingRun();
    await seedLinkedAction(session.id, invocationId, 'locked');
    await finishAgentRun(lease, 'interrupted');

    await finalizeReceiptedAgentRun(run.id, session.id, DEMO_USER_ID);

    const invocation = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
    expect(invocation.status).toBe('failed');
    expect(invocation.errorCode).toBe('MFA_LOCKED');

    const finalized = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finalized.status).toBe('failed');
    expect(finalized.errorCode).toBe('MFA_LOCKED');
    expect(finalized.finishedAt).toBeInstanceOf(Date);
  });

  it('still refuses to finalize while another action is an open decision', async () => {
    const { session, run, lease, invocationId } = await seedVerifyingRun();
    // A second, already-answered invocation whose decision is still OPEN: the run must stay open.
    const answeredId = newId('inv');
    await startInvocationWithEvent(
      lease,
      {
        id: answeredId,
        callId: 'call_open',
        toolName: 'transfer_money',
        argsJson: '{"amount":"50.00"}',
        requestDigest: 'call_open_digest',
        policy: { safety: 'reconcile_only', maxAttempts: 1 },
      },
      STARTED_EVENT,
    );
    await finishInvocationWithEvent(
      lease,
      { invocationId: answeredId, status: 'completed', resultJson: '{"ok":true}' },
      { channel: 'internal', eventType: 'invocation_completed', payloadJson: '{}' },
    );
    await seedLinkedAction(session.id, invocationId, 'locked');
    const openAction = await seedLinkedAction(session.id, answeredId, 'pending');
    await finishAgentRun(lease, 'interrupted');

    await finalizeReceiptedAgentRun(run.id, session.id, DEMO_USER_ID);

    // The locked invocation DID settle (that fact is final) ...
    const lockedInvocation = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocationId } });
    expect(lockedInvocation.status).toBe('failed');
    expect(lockedInvocation.errorCode).toBe('MFA_LOCKED');
    // ... but the run itself stays open: one decision is still pending.
    const stillOpen = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stillOpen.status).toBe('interrupted');
    expect(stillOpen.finishedAt).toBeNull();
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: openAction.id } })).status).toBe('pending');
  });

  it('keeps `locked` out of the OPEN vocabulary and inside the settled/terminal one', () => {
    expect(OPEN_PENDING_ACTION_STATUSES).not.toContain('locked');
    expect(SETTLED_PENDING_ACTION_STATUSES).toContain('locked');
    expect(TERMINAL_PENDING_ACTION_STATUSES).toContain('locked');
    // `locked` is never revived: it is not an open decision.
    expect([...OPEN_PENDING_ACTION_STATUSES]).toEqual(['pending', 'awaiting_mfa']);
  });

  it('never grants an execution lease to a locked action', async () => {
    const { session, lease, invocationId } = await seedVerifyingRun();
    const action = await seedLinkedAction(session.id, invocationId, 'locked');
    await finishAgentRun(lease, 'interrupted');
    const now = new Date();

    const granted = await claimPendingActionLease(action.id, {
      owner: 'worker_locked',
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });

    expect(granted).toBe(false);
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).executionLeaseOwner).toBeNull();

    // Sanity: the same call DOES lease an open action, so the refusal above is the status rule.
    const open = await seedLinkedAction(session.id, invocationId, 'pending');
    expect(await claimPendingActionLease(open.id, { owner: 'worker_locked', expiresAt: new Date(now.getTime() + 60_000), now })).toBe(true);
  });
});
