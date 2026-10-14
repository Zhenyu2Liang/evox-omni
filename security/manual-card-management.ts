import { z } from 'zod';
import type { PendingAction, Prisma } from '@/lib/db/prisma';
import { prisma, dbClient } from '@/lib/db/client';
import { withinTransaction } from '@/lib/db/unit-of-work';
import { AppError } from '@/lib/errors';
import { canonicalCommandArgs, type BankingCommand } from '@/lib/contracts/command';
import type { AddDemoCardRequest, CardChange, CardChangeResponse, ManualCardCommandName } from '@/lib/contracts/card-management';
import { MANUAL_CARD_COMMAND_NAMES as NAMES, isManualCardCommand } from '@/lib/contracts/card-management';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { requestDigest } from '@/lib/ledger';
import { safeParse, toJson } from '@/lib/json';
import { realNow } from '@/lib/clock';
import { recordAudit } from '@/audit';
import { addDemoCard, deleteDemoCard, assertDemoCardDeletable } from '@/banking-sdk/card';
import type { CardView } from '@/banking-sdk';
import { executeBankingCommand, readCommandReceipt } from '@/agent/command-execution';
import { issueChallenge, verify } from './mfa';
import { isLocked } from './circuit-breaker';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';

interface Identity { userId: string; sessionId: string }

const amount = z.string().regex(/^\d+(?:\.\d{1,2})?$/).transform(value => centsToMoney(moneyToCents(value)));
export const addDemoCardSchema = z.object({ requestId: z.string().uuid(), type: z.enum(['DEBIT', 'CREDIT', 'VIRTUAL']),
  creditLimit: amount.optional(), monthlyLimit: amount.optional() }).strict().superRefine((input, ctx) => {
  if ((input.type === 'CREDIT') !== (input.creditLimit !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only credit cards require a credit limit.', path: ['creditLimit'] });
  if (input.creditLimit !== undefined && moneyToCents(input.creditLimit) <= 0n) ctx.addIssue({ code: 'custom', message: 'Credit limit must be positive.', path: ['creditLimit'] });
});
export const deleteDemoCardSchema = z.object({ requestId: z.string().uuid() }).strict();
export const verifyCardChangeSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

function commandFor(row: PendingAction): BankingCommand {
  if (!isManualCardCommand(row.toolName)) throw new AppError('SECURITY_DENIED', 'This is not a manual card change.');
  const args = canonicalCommandArgs(safeParse<Record<string, unknown>>(row.argsJson, {}));
  return { userId: row.userId, operationKey: row.id, toolName: row.toolName, args,
    digest: requestDigest({ version: 1, userId: row.userId, toolName: row.toolName, args }) };
}

async function ownedChange(identity: Identity, id: string): Promise<PendingAction> {
  const row = await dbClient().pendingAction.findUnique({ where: { id } });
  if (!row) throw new AppError('NOT_FOUND', 'Card change not found.');
  if (row.userId !== identity.userId || row.sessionId !== identity.sessionId || !isManualCardCommand(row.toolName)) throw new AppError('SECURITY_DENIED', 'This card change belongs to another workspace.');
  return row;
}

function toChange(row: PendingAction): CardChange {
  const args = safeParse<Record<string, unknown>>(row.argsJson, {});
  const result = safeParse<{ data?: CardView }>(row.resultJson ?? '', {});
  const summary = safeParse<{ card?: CardView }>(row.summaryJson, {});
  return { id: row.id, kind: row.toolName === 'manual_add_card' ? 'add' : 'delete',
    status: row.status === 'executed' ? 'executed' : row.status === 'cancelled' ? 'cancelled' : row.status === 'locked' ? 'locked' : 'pending', requiresMfa: true,
    ...(args.type ? { type: args.type as AddDemoCardRequest['type'] } : {}),
    ...(args.creditLimit ? { creditLimit: args.creditLimit as AddDemoCardRequest['creditLimit'] } : {}),
    ...(args.monthlyLimit ? { monthlyLimit: args.monthlyLimit as AddDemoCardRequest['monthlyLimit'] } : {}),
    ...(result.data ?? summary.card ? { card: result.data ?? summary.card } : {}) };
}

async function auditChange(row: PendingAction, status: 'waiting_verification' | 'success' | 'cancelled' | 'failed', client: Prisma.TransactionClient,
  result?: unknown, mfaResult?: 'success' | 'failed'): Promise<void> {
  await recordAudit({ timestamp: realNow(), userId: row.userId, sessionId: row.sessionId,
    userRequest: 'Manual demo card management', intent: row.toolName, toolName: row.toolName,
    riskLevel: 'RED', confirmationRequired: true, confirmed: status === 'success' || status === 'failed', mfaRequired: true,
    mfaResult, toolArgs: safeParse(row.argsJson, {}), toolResult: result, status,
    detail: 'Simulated card record management; no real card issuance or account closure.' },
  { strict: true, client, ...(status !== 'failed' ? { dedupeKey: `${row.id}:${status}` } : {}) });
}

/** Stable request identity protects proposals and writes from browser retries and process restarts. */
export async function proposeCardChange(identity: Identity, request: AddDemoCardRequest | { requestId: string; cardId: string }): Promise<CardChangeResponse> {
  if (await isLocked(identity.sessionId)) throw new AppError('CIRCUIT_OPEN', 'Strong verification is locked.');
  const { requestId, ...args } = request;
  const toolName: ManualCardCommandName = 'cardId' in args ? 'manual_delete_card' : 'manual_add_card';
  const id = `cardchange_${requestDigest({ userId: identity.userId, requestId }).slice(0, 32)}`;
  const normalized = canonicalCommandArgs(args);
  const row = await prisma.$transaction(async client => withinTransaction(client, async () => {
    await client.user.updateMany({ where: { id: identity.userId }, data: { id: identity.userId } });
    const existing = await client.pendingAction.findUnique({ where: { id } });
    if (existing) {
      if (existing.userId !== identity.userId || existing.sessionId !== identity.sessionId || existing.toolName !== toolName ||
          requestDigest(safeParse(existing.argsJson, {})) !== requestDigest(normalized)) throw new AppError('CONFLICT', 'The request identity already belongs to another card change.');
      return existing;
    }
    let card: CardView | undefined;
    if ('cardId' in args) {
      card = await assertDemoCardDeletable(identity.userId, args.cardId, id);
    }
    const created = await client.pendingAction.create({ data: { id, ...identity, toolName, argsJson: toJson(normalized),
      summaryJson: toJson({ title: 'Manual demo card management', card }), riskLevel: 'RED', requiresMfa: true,
      status: 'awaiting_mfa', intent: toolName, userRequest: 'Manual demo card management' } });
    await auditChange(created, 'waiting_verification', client);
    return created;
  }));
  if (!['executed', 'cancelled'].includes(row.status)) await issueChallenge(id);
  return { change: toChange(row) };
}

export async function listCardChanges(identity: Identity): Promise<CardChange[]> {
  const rows = await prisma.pendingAction.findMany({ where: { ...identity, toolName: { in: NAMES },
    status: { in: ['awaiting_mfa', 'pending', 'locked'] } }, orderBy: { createdAt: 'asc' } });
  const locked = await isLocked(identity.sessionId);
  return rows.map(row => ({ ...toChange(row), ...(locked ? { status: 'locked' as const } : {}) }));
}

/** Verification is the explicit confirmation of an immutable, reviewed proposal. */
export async function verifyCardChange(identity: Identity, id: string, code: string): Promise<CardChangeResponse> {
  const row = await ownedChange(identity, id);
  const command = commandFor(row);
  const receipt = await readCommandReceipt(command);
  if (receipt) return { change: { ...toChange(row), status: 'executed', card: receipt.data as CardView }, ok: true };
  if (!['awaiting_mfa', 'pending', 'locked'].includes(row.status)) throw new AppError('CONFLICT', 'This card change is no longer pending.');
  if (await isLocked(identity.sessionId)) throw new AppError('CIRCUIT_OPEN', 'Strong verification is locked.');
  await issueChallenge(id);
  const checked = await verify(id, code);
  if (!checked.ok) {
    const concurrentReceipt = await readCommandReceipt(command);
    if (concurrentReceipt) return { change: { ...toChange(row), status: 'executed', card: concurrentReceipt.data as CardView }, ok: true };
    throw checked.error;
  }
  if (!checked.value.ok) {
    await prisma.$transaction(async client => {
      await auditChange(row, 'failed', client, { ok: false, errorCode: 'MFA_FAILED' }, 'failed');
    });
    return { change: { ...toChange(row), status: checked.value.locked ? 'locked' : 'pending' }, ok: false,
      attemptsLeft: checked.value.attemptsLeft, locked: checked.value.locked };
  }
  const result = await executeBankingCommand(command, async () => {
    const card = command.toolName === 'manual_add_card'
      ? await addDemoCard(identity.userId, command.args as unknown as Omit<AddDemoCardRequest, 'requestId'>)
      : await deleteDemoCard(identity.userId, String(command.args.cardId), id);
    return { ok: true, data: card };
  }, { context: { sessionId: identity.sessionId, fence: async client => {
    const current = await client.pendingAction.findUnique({ where: { id }, include: { mfa: true } });
    const challenge = current?.mfa;
    const expected = requestDigest({ userId: row.userId, toolName: row.toolName, args: command.args });
    const breaker = await client.circuitBreakerState.findUnique({ where: { key: `user:${identity.userId}` } });
    if (!current || current.userId !== identity.userId || current.sessionId !== identity.sessionId ||
        !['awaiting_mfa', 'pending', 'locked'].includes(current.status) || breaker?.locked ||
        current.argsJson !== row.argsJson || !challenge || challenge.status !== 'verified' || challenge.consumedAt ||
        !challenge.expiresAt || challenge.expiresAt.getTime() <= realNow() || challenge.commandDigest !== expected) {
      throw new AppError('SECURITY_DENIED', 'The card change verification is expired, revoked or invalid.');
    }
    const claimed = await client.pendingAction.updateMany({ where: { id, userId: identity.userId, sessionId: identity.sessionId,
      status: current.status, argsJson: row.argsJson }, data: { status: 'confirmed' } });
    if (claimed.count !== 1) throw new AppError('CONFLICT', 'The card change was changed concurrently.');
  } }, onCommit: async (client, outcome) => {
    await client.mfaChallenge.update({ where: { actionId: id }, data: { consumedAt: new Date(realNow()) } });
    await client.pendingAction.update({ where: { id }, data: { status: 'executed', resultJson: toJson(outcome) } });
    await auditChange(row, 'success', client, outcome, 'success');
  } });
  return { change: { ...toChange(row), status: 'executed', card: result.data as CardView }, ok: true, attemptsLeft: MFA_MAX_ATTEMPTS, locked: false };
}

export async function cancelCardChange(identity: Identity, id: string): Promise<CardChangeResponse> {
  const row = await ownedChange(identity, id);
  if (row.status === 'cancelled') return { change: toChange(row), ok: true };
  await prisma.$transaction(async client => {
    await client.user.updateMany({ where: { id: identity.userId }, data: { id: identity.userId } });
    const cancelled = await client.pendingAction.updateMany({ where: { id, ...identity, status: { in: ['pending', 'awaiting_mfa', 'locked'] } }, data: { status: 'cancelled' } });
    if (cancelled.count !== 1) throw new AppError('CONFLICT', 'Only an unexecuted card change can be cancelled.');
    await client.mfaChallenge.updateMany({ where: { actionId: id }, data: { status: 'failed', consumedAt: new Date(realNow()) } });
    await auditChange(row, 'cancelled', client);
  });
  return { change: { ...toChange(row), status: 'cancelled' }, ok: true };
}
