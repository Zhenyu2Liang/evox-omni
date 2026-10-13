import type { Prisma, ExecutionReceipt } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { withinTransaction } from '@/lib/db/unit-of-work';
import { AppError } from '@/lib/errors';
import { executionReceiptId, requestDigest } from '@/lib/ledger';
import { safeParse, toJson } from '@/lib/json';
import type { BankingCommand } from '@/lib/contracts/command';
import type { ToolExecutionResult } from './tools';
import { withBankingExecution, type BankingExecutionContext } from '@/banking-sdk/execution-context';
import { recordRiskSignal } from '@/security/incidents';
import { restoreInvocationFromReceipt } from '@/lib/db/repositories/agentRun';
import { banking, type TransferInput } from '@/banking-sdk';

export interface CommandExecutionOptions {
  context: BankingExecutionContext;
  onCommit?: (client: Prisma.TransactionClient, result: ToolExecutionResult) => Promise<void>;
}

class RejectedCommand extends Error {
  constructor(readonly result: ToolExecutionResult) { super(result.error ?? 'Banking command failed'); }
}

/** Verify immutable response projections and, for transfers, the actual posted ledger. */
async function verifiedResponse(command: BankingCommand, receipt: ExecutionReceipt): Promise<ToolExecutionResult> {
  if (receipt.commandDigest !== command.digest || receipt.toolName !== command.toolName) {
    throw new AppError('CONFLICT', 'The operation identity already belongs to a different command.');
  }
  const result = safeParse<ToolExecutionResult | null>(receipt.responseJson, null);
  if (!result?.ok || requestDigest({ data: result.data }) !== requestDigest({ data: safeParse(receipt.resultJson, null) })) {
    throw new AppError('CONFLICT', 'The committed operation receipt is inconsistent. Manual reconciliation is required.');
  }
  if (command.toolName === 'transfer_money') {
    const verified = await banking.transfer.getCommittedTransfer({ ...command.args,
      userId: command.userId, idempotencyKey: command.operationKey } as TransferInput);
    if (!verified || requestDigest({ data: result.data }) !== requestDigest({ data: verified })) {
      throw new AppError('CONFLICT', 'The transfer receipt does not match its posted ledger.');
    }
  }
  return result;
}

/** Original receipts are returned before consulting any mutable account or resource. */
export async function readCommandReceipt(command: BankingCommand): Promise<ToolExecutionResult | undefined> {
  const receipt = await prisma.executionReceipt.findUnique({
    where: { userId_key: { userId: command.userId, key: command.operationKey } },
  });
  if (!receipt) return;
  // A direct SDK transfer has the same current result receipt but no agent presentation yet.
  if (receipt.toolName === 'transfer_money' && command.toolName === 'transfer_money' &&
      receipt.commandDigest === null && receipt.responseJson === null) {
    await banking.transfer.getCommittedTransfer({ ...command.args,
      userId: command.userId, idempotencyKey: command.operationKey } as TransferInput);
    return;
  }
  return verifiedResponse(command, receipt);
}

/** Every registered write shares one transaction, immutable receipt, and required audit. */
export async function executeBankingCommand(
  command: BankingCommand,
  execute: () => Promise<ToolExecutionResult>,
  options: CommandExecutionOptions,
): Promise<ToolExecutionResult> {
  const committed = await readCommandReceipt(command);
  if (committed) return committed;
  try {
    const result = await prisma.$transaction(async client => withinTransaction(client, async () => {
      // Acquire the SQLite writer before the read/claim sequence. No balance is changed here.
      await client.user.updateMany({ where: { id: command.userId }, data: { id: command.userId } });
      const existing = await client.executionReceipt.findUnique({
        where: { userId_key: { userId: command.userId, key: command.operationKey } },
      });
      if (existing && (existing.commandDigest !== null || existing.responseJson !== null ||
          existing.toolName !== 'transfer_money' || command.toolName !== 'transfer_money')) {
        return verifiedResponse(command, existing);
      }
      await options.context.fence?.(client);
      const outcome = await withBankingExecution({ ...options.context, onTransactionCommitted: undefined,
        onTransferCommit: options.onCommit ? undefined : options.context.onTransferCommit }, execute);
      if (!outcome.ok) throw new RejectedCommand(outcome);
      await options.onCommit?.(client, outcome);
      // Compose the SDK transfer result and agent presentation in the same commit.
      const receipt = await client.executionReceipt.findUnique({
        where: { userId_key: { userId: command.userId, key: command.operationKey } },
      });
      const responseJson = toJson(outcome);
      if (receipt) {
        if (receipt.toolName !== command.toolName) throw new AppError('CONFLICT', 'Conflicting committed tool identity.');
        await client.executionReceipt.update({ where: { id: receipt.id }, data: { commandDigest: command.digest, responseJson } });
      } else {
        await client.executionReceipt.create({ data: {
          id: executionReceiptId(command.userId, command.operationKey), userId: command.userId,
          key: command.operationKey, toolName: command.toolName, requestDigest: command.digest,
          commandDigest: command.digest, resultJson: toJson(outcome.data), responseJson,
        } });
      }
      const invocation = await client.toolInvocation.findFirst({ where: {
        operationKey: command.operationKey, toolName: command.toolName, run: { userId: command.userId },
      } });
      if (invocation) await restoreInvocationFromReceipt({ invocationId: invocation.id, userId: command.userId,
        toolName: command.toolName, operationKey: command.operationKey, resultJson: responseJson }, client);
      return outcome;
    }), { maxWait: 10000, timeout: 20000 });
    options.context.onTransactionCommitted?.();
    return result;
  } catch (error) {
    if (error instanceof RejectedCommand) {
      if (options.context.sessionId) await recordRiskSignal({ sessionId: options.context.sessionId,
        kind: 'repeated_business_failure', message: 'A banking command failed before committing.',
        detail: { toolName: command.toolName, operationKey: command.operationKey }, dedupeKey: `failed:${command.userId}:${command.operationKey}` });
      return error.result;
    }
    throw error;
  }
}
