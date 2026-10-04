/**
 * pendingAction.claim.test.ts — DB-backed unit spec for the ATOMIC, ownership-aware
 * persistence primitives added to `lib/db/repositories/pendingAction.ts`.
 *
 * Lives INSIDE the `lib/db/repositories` node (the sibling `tests/` node is read-only), and is
 * run through `lib/db/vitest.staging.config.ts` against the REAL test SQLite
 * (`tests/helpers/db` + `tests/helpers/fixtures` imported READ-ONLY).
 *
 *     npx vitest run --config lib/db/vitest.staging.config.ts
 *
 * A UNIQUE `sessionId` per test keeps the circuit-breaker/session state isolated — the shared
 * SQLite file is reset+seeded before every test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { newId } from '@/lib/ids';
import {
  claimPendingAction,
  createPendingAction,
  getPendingActionOwnership,
  setPendingActionStatus,
} from '@/lib/db/repositories/pendingAction';
import { pendingActions } from '@/lib/db/repositories';

/** The confirmation-card summary persisted on each seeded action. */
const SUMMARY = {
  title: '转账',
  toolName: 'transfer_money' as const,
  tier: 'YELLOW' as const,
  fields: [] as Array<{ label: string; value: string }>,
  requiresMfa: false,
};

/** Seed one `PendingAction` for the demo user under a fresh, unique session. */
async function seedAction(status: 'pending' | 'cancelled' = 'pending') {
  const sessionId = newId('pa_claim');
  const row = await createPendingAction({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { name: '张伟', amount: 200 },
    tier: 'YELLOW',
    requiresMfa: false,
    summary: SUMMARY,
    status,
  });
  return { id: row.id, sessionId };
}

describe('claimPendingAction — exactly-once atomic claim', () => {
  beforeEach(resetDatabase, 30000);
  afterAll(disconnectTestPrisma, 30000);

  it('(a) claims a pending action once (pending -> confirmed) and persists the new status', async () => {
    const { id } = await seedAction('pending');

    // Exercised through the BARREL to prove the additive exports are wired in.
    const claimed = await pendingActions.claimPendingAction({
      actionId: id,
      from: ['pending'],
      to: 'confirmed',
    });

    expect(claimed).toBe(true);
    const row = await getTestPrisma().pendingAction.findUnique({ where: { id } });
    expect(row?.status).toBe('confirmed');
  });

  it('(b) rejects a SECOND identical claim and leaves the row untouched', async () => {
    const { id } = await seedAction('pending');

    const first = await claimPendingAction({ actionId: id, from: ['pending'], to: 'confirmed' });
    expect(first).toBe(true);

    const second = await claimPendingAction({ actionId: id, from: ['pending'], to: 'confirmed' });
    expect(second).toBe(false);

    const row = await getTestPrisma().pendingAction.findUnique({ where: { id } });
    expect(row?.status).toBe('confirmed');
  });

  it('(c) enforces userId ownership scoping', async () => {
    const { id } = await seedAction('pending');

    const wrongUser = await claimPendingAction({
      actionId: id,
      from: ['pending'],
      to: 'confirmed',
      userId: 'user_someone_else',
    });
    expect(wrongUser).toBe(false);
    expect((await getPendingActionOwnership(id))?.status).toBe('pending');

    const rightUser = await claimPendingAction({
      actionId: id,
      from: ['pending'],
      to: 'confirmed',
      userId: DEMO_USER_ID,
    });
    expect(rightUser).toBe(true);
  });

  it('(c) enforces sessionId scoping', async () => {
    const { id } = await seedAction('pending');

    const wrongSession = await claimPendingAction({
      actionId: id,
      from: ['pending'],
      to: 'confirmed',
      sessionId: newId('pa_claim_other'),
    });
    expect(wrongSession).toBe(false);
    expect((await getPendingActionOwnership(id))?.status).toBe('pending');
  });

  it('(d) honors the `from` set; a non-matching source status is not claimed', async () => {
    const { id } = await seedAction('cancelled');

    const fromPending = await claimPendingAction({ actionId: id, from: ['pending'], to: 'confirmed' });
    expect(fromPending).toBe(false);

    const fromCancelled = await claimPendingAction({ actionId: id, from: ['cancelled'], to: 'confirmed' });
    expect(fromCancelled).toBe(true);
    expect((await getPendingActionOwnership(id))?.status).toBe('confirmed');
  });

  it('(d) setPendingActionStatus persists the terminal status; ownership reader returns identity', async () => {
    const { id, sessionId } = await seedAction('pending');

    await setPendingActionStatus(id, 'executed');

    const ownership = await getPendingActionOwnership(id);
    expect(ownership).toEqual({ id, userId: DEMO_USER_ID, sessionId, status: 'executed' });
    expect(Object.keys(ownership ?? {}).sort()).toEqual(['id', 'sessionId', 'status', 'userId']);
  });

  it('returns null ownership for an unknown action', async () => {
    const ownership = await getPendingActionOwnership('pa_does_not_exist');
    expect(ownership).toBeNull();
  });
});
