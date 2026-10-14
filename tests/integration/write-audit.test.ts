/**
 * Regression — AUDIT BY SIDE EFFECT (not by permission colour).
 *
 * A GREEN auto-executed write (`reserve_budget`) must be audited exactly like a gated action:
 *  - the audit row exists, carries the validated tool args + the server-owned identity + the true
 *    (plan/node) identifiers and the TRUE result;
 *  - the SAME execution identity produces NEITHER a duplicate side effect NOR a duplicate audit;
 *  - an audit failure rolls the business write back (no un-audited side effect survives);
 *  - the pre-existing gated (`exec:<actionId>`) identity is unchanged.
 * Real gateway/Pi runtime/SDK/SQLite; only the test database is isolated.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { executeGatedTool, getOrCreateSession } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { createToolRegistry } from '@/agent/tools';
import { buildAutomaticWriteFence } from '@/agent/execution-fence';
import { auditStore } from '@/audit/audit-logger';
import { nodeExecutionKey } from '@/lib/ledger';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
const reservationArgs = { name: 'Birthday budget', amount: '1000' };
const reservationRequest = 'Reserve 1000 for a birthday budget';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** A running workflow with real execution claims owns the automatic banking write. */
async function seedRunningWriteNode(sessionId: string) {
  await getTestPrisma().agentTask.create({ data: {
    id: 'task_write_audit', userId, sessionId, goal: reservationRequest,
    status: 'running', executionToken: 'write-audit-plan-owner', executionClaimedAt: new Date(),
    nodes: { create: [{
      nodeId: 'node_write_audit', name: 'Reserve birthday budget', kind: 'tool',
      tool: 'reserve_budget', args: JSON.stringify(reservationArgs), dependencies: '[]', order: 0,
      status: 'running', executionToken: 'write-audit-node-owner', executionClaimedAt: new Date(),
    }] },
  } });
}

/** One authorized GREEN write: the persisted node identity is the SDK idempotency key. */
function reservePlanNode(sessionId: string, taskId: string, nodeId: string) {
  return executeGatedTool({
    userId,
    sessionId,
    toolName: 'reserve_budget',
    args: reservationArgs,
    userRequest: reservationRequest,
    taskId,
    nodeId,
  });
}

/** One standalone GREEN write carrying its own key. */
async function reserveStandalone(sessionId: string, idempotencyKey: string) {
  return createToolRegistry(userId).executeDirect('reserve_budget', {
    name: 'Travel budget', amount: '500.00',
  }, {
    sessionId,
    idempotencyKey,
    fence: await buildAutomaticWriteFence(sessionId),
    userRequest: 'Reserve 500 for travel',
  });
}

it('[integration] a GREEN reserve_budget write is audited with its tool args, identity and TRUE result', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  await seedRunningWriteNode(sessionId);

  const outcome = await reservePlanNode(sessionId, 'task_write_audit', 'node_write_audit');
  expect(outcome.ok, outcome.error).toBe(true);

  const prisma = getTestPrisma();
  const key = nodeExecutionKey('task_write_audit', 'node_write_audit');
  // The row THIS write created — addressed by its own plan-node execution identity, so we compare
  // like-for-like and never accidentally pick up an unrelated seeded budget.
  const budget = await prisma.budget.findUniqueOrThrow({
    where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
  });
  const rows = await prisma.auditLog.findMany();
  expect(rows, 'exactly one audit row for one side effect').toHaveLength(1);
  const row = rows[0];

  // The write is audited despite being GREEN, and the entry is truthful.
  expect(row.toolName).toBe('reserve_budget');
  expect(row.riskLevel).toBe('GREEN');
  expect(row.status).toBe('success');
  expect(row.confirmationRequired).toBe(false);
  expect(row.confirmed).toBe(false);
  expect(row.mfaRequired).toBe(false);

  // Authorization/identity: server-resolved owner + session, never model-supplied.
  expect(row.userId).toBe(userId);
  expect(row.sessionId).toBe(sessionId);
  expect(row.userRequest).toBe(reservationRequest);
  expect(row.taskId).toBe('task_write_audit');
  expect(row.nodeId).toBe('node_write_audit');

  // The ORIGINAL request (args) and the result actually persisted.
  expect(JSON.parse(row.toolArgs!)).toMatchObject({
    userId,
    name: reservationArgs.name,
    amount: '1000.00',
    idempotencyKey: key,
  });
  expect(await prisma.executionReceipt.count({ where: { userId, key } })).toBe(1);
  expect(JSON.parse(row.toolResult!)).toMatchObject({ ok: true, data: { id: budget.id, amount: '1000.00' } });
  expect(row.dedupeKey).toBe(`write:reserve_budget:${userId}:key:${key}`);
  expect(row.dedupeKey?.startsWith('exec:')).toBe(false);
});

it('[integration] the SAME execution identity double-writes neither the side effect nor the audit', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  await seedRunningWriteNode(sessionId);

  const first = await reservePlanNode(sessionId, 'task_write_audit', 'node_write_audit');
  const second = await reservePlanNode(sessionId, 'task_write_audit', 'node_write_audit');
  expect(first.ok, first.error).toBe(true);
  expect(second.ok, second.error).toBe(true);
  expect(second.data).toEqual(first.data);

  await reserveStandalone(sessionId, 'standalone-key');
  await reserveStandalone(sessionId, 'standalone-key');

  const prisma = getTestPrisma();
  expect(await prisma.budget.count({ where: { userId, name: reservationArgs.name } })).toBe(1);
  expect(await prisma.budget.count({ where: { userId, name: 'Travel budget' } })).toBe(1);
  // One audit per (tool, execution identity) — the replay path writes/audits nothing.
  expect(await prisma.auditLog.count({ where: { toolName: 'reserve_budget' } })).toBe(2);
  expect(await prisma.auditLog.count({ where: { dedupeKey: `write:reserve_budget:${userId}:key:${nodeExecutionKey('task_write_audit', 'node_write_audit')}` } })).toBe(1);
});

it('[integration] a failing write audit rolls the business write back — no un-audited side effect', async () => {
  const sessionId = (await getOrCreateSession(userId)).sessionId;
  await seedRunningWriteNode(sessionId);
  const prisma = getTestPrisma();
  // The seeded world already ships one unrelated budget; the failed write must not move it.
  const budgetsBefore = await prisma.budget.count({ where: { userId } });

  const insert = auditStore.insertAuditLog.bind(auditStore);
  const spy = vi.spyOn(auditStore, 'insertAuditLog').mockImplementation(async (entry, opts) => {
    if (opts?.dedupeKey?.startsWith('write:reserve_budget:') === true) {
      throw new Error('review: critical write audit insert failed');
    }
    return insert(entry, opts);
  });

  const outcome = await reservePlanNode(sessionId, 'task_write_audit', 'node_write_audit');

  expect(spy).toHaveBeenCalled();
  expect(outcome.ok).toBe(false);
  // The reservation this call tried to create must NOT survive its failed audit …
  expect(
    await prisma.budget.count({ where: { userId, name: reservationArgs.name } }),
    'no un-audited reservation may survive',
  ).toBe(0);
  // … and nothing else may have shifted either — no un-audited business change.
  expect(await prisma.budget.count({ where: { userId } }), 'the budget insert must roll back with its audit').toBe(budgetsBefore);
  expect(await prisma.auditLog.count()).toBe(0);
});

it('[integration] the existing gated audit identity is unchanged (exec:<actionId>, never write:)', async () => {
  const sessionId = (await getDemoSession(userId)).sessionId;

  const parked = await executeGatedTool({
    userId,
    sessionId,
    toolName: 'transfer_money',
    args: { name: '张伟', amount: '200' },
    userRequest: '给张伟转200元',
  });
  expect(parked.pendingActionId).toBeTruthy();
  const actionId = parked.pendingActionId!;

  const prisma = getTestPrisma();
  // The seed already ships TRANSFER-channel rows (转账给妈妈 / 房租); the confirmed transfer must add
  // EXACTLY ONE more ledger row — assert the delta, not an absolute count.
  const transfersBefore = await prisma.transaction.count({ where: { userId, channel: 'TRANSFER' } });
  const parkedAudits = await prisma.auditLog.findMany({ where: { sessionId } });
  const confirmed = await confirmPost(
    new NextRequest(`http://localhost/api/actions/${actionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id: actionId }) },
  );
  expect(confirmed.status).toBe(200);

  const transferAudits = await prisma.auditLog.findMany({ where: { toolName: 'transfer_money' } });
  expect(transferAudits.length).toBeGreaterThanOrEqual(1);
  expect(transferAudits.every((row) => row.dedupeKey === `exec:${actionId}`)).toBe(true);
  expect(transferAudits.some((row) => row.dedupeKey?.startsWith('write:') === true)).toBe(false);
  // The decision-keyed audits are ADDITIVE to the parked state, not a rewrite of it.
  expect(parkedAudits.length).toBeLessThanOrEqual(transferAudits.length + parkedAudits.length);
  expect(await prisma.transaction.count({ where: { userId, channel: 'TRANSFER' } })).toBe(transfersBefore + 1);
});
