import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { withinTransaction } from '@/lib/db/unit-of-work';
import { AppError } from '@/lib/errors';
import { normalizeMoney } from '@/lib/money';
import { requestDigest, ledgerKeyForAction } from '@/lib/ledger';
import { safeParse, toJson } from '@/lib/json';
import { banking, type ConsumeCardResult } from '@/banking-sdk';
import { verifyAction } from '@/agent/confirmation';
import { prepareBankingCommand } from '@/lib/contracts/command';
import { readCommandReceipt } from '@/agent/command-execution';
import type { CardConsumptionResponse } from '@/lib/contracts/card-consumption';
import { recordAudit } from '@/audit';
import { realNow } from '@/lib/clock';
import { issueChallenge } from './mfa';
import { assertSessionMayWrite } from './execution-policy';

interface Identity { userId: string; sessionId: string }
interface ConsumptionRequest {
  cardId: string; amount: string; category?: string; merchant?: string; executionKey?: string;
  actionId?: string; code?: string; confirmed?: boolean;
}

/** Page proposals use the same persisted RED action, MFA and execution fence as agent tools. */
export async function submitCardConsumption(identity: Identity, input: ConsumptionRequest): Promise<CardConsumptionResponse> {
  const args = { cardId: input.cardId, amount: normalizeMoney(input.amount), category: input.category?.trim() || '其他',
    ...(input.merchant?.trim() ? { merchant: input.merchant.trim() } : {}) };
  const id = input.actionId ?? `cardconsume_${requestDigest({ ...identity, requestId: input.executionKey ?? randomUUID() }).slice(0, 32)}`;
  const row = await prisma.$transaction(async client => withinTransaction(client, async () => {
    await client.user.updateMany({ where: { id: identity.userId }, data: { id: identity.userId } });
    const existing = await client.pendingAction.findUnique({ where: { id } });
    if (existing) {
      if (existing.userId !== identity.userId || existing.sessionId !== identity.sessionId ||
          existing.toolName !== 'consume_virtual_card' || requestDigest(safeParse(existing.argsJson, {})) !== requestDigest(args)) {
        throw new AppError('CONFLICT', 'The consumption identity belongs to another request.');
      }
      return existing;
    }
    if (input.actionId) throw new AppError('NOT_FOUND', 'Consumption action not found.');
    await assertSessionMayWrite(identity.sessionId, client, identity.userId);
    const card = (await banking.card.getCards(identity.userId)).find(card => card.id === input.cardId);
    if (!card) throw new AppError('NOT_FOUND', 'Card not found.');
    if (card.type === 'CREDIT' || card.status !== 'ACTIVE' || card.linkedAccountStatus !== 'LINKED') {
      throw new AppError('CONFLICT', 'This card cannot be consumed.');
    }
    const created = await client.pendingAction.create({ data: { id, ...identity, toolName: 'consume_virtual_card',
      argsJson: toJson(args), riskLevel: 'RED', requiresMfa: true, status: 'awaiting_mfa',
      userRequest: 'Manual card consumption', summaryJson: toJson({ title: '卡片消费', toolName: 'consume_virtual_card',
        tier: 'RED', requiresMfa: true, amount: args.amount,
        fields: [{ label: '卡片', value: card.numberMasked }, { label: '金额', value: args.amount },
          { label: '类别', value: args.category }, ...(args.merchant ? [{ label: '商户', value: args.merchant }] : [])] }) } });
    await recordAudit({ timestamp: realNow(), ...identity, userRequest: 'Manual card consumption',
      toolName: 'consume_virtual_card', riskLevel: 'RED', confirmationRequired: true, confirmed: false,
      mfaRequired: true, toolArgs: args, status: 'waiting_verification' }, { strict: true, client, dedupeKey: `${id}:proposal` });
    return created;
  }));
  if (row.status === 'executed') {
    const receipt = await readCommandReceipt(prepareBankingCommand(identity.userId, ledgerKeyForAction({ id }), 'consume_virtual_card', args));
    if (!receipt?.ok) throw new AppError('CONFLICT', 'Consumption receipt cannot be verified.');
    return { actionId: id, status: 'executed', ok: true, result: receipt.data as ConsumeCardResult };
  }
  if (!['pending', 'awaiting_mfa'].includes(row.status)) throw new AppError('CONFLICT', 'This consumption is no longer pending.');
  await assertSessionMayWrite(identity.sessionId, undefined, identity.userId);
  if (!input.actionId) {
    await issueChallenge(id);
    return { actionId: id, status: 'awaiting_mfa', ok: false };
  }
  if (input.confirmed !== true || !input.code) throw new AppError('SECURITY_DENIED', 'Confirm the original consumption and provide its verification code.');
  const outcome = await verifyAction(id, input.code, { ...identity, narrate: false });
  if (outcome.result && !outcome.result.ok) {
    throw new AppError(outcome.result.errorCode ?? 'TOOL_FAILED', outcome.result.error ?? 'Consumption failed.');
  }
  return { actionId: id, status: outcome.status, ok: outcome.ok,
    ...(outcome.result?.ok ? { result: outcome.result.data as ConsumeCardResult } : {}),
    ...(outcome.failure?.attemptsLeft !== undefined ? { attemptsLeft: outcome.failure.attemptsLeft } : {}), message: outcome.message };
}
