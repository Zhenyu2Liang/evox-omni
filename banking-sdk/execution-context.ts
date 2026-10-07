import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import type { ExecutionFenceCheck } from './fence';
import type { TransferResult } from './types';

/** Trusted server callbacks, scoped to one invocation; never read from model arguments. */
export interface BankingExecutionContext {
  fence?: ExecutionFenceCheck;
  onTransferCommit?: (tx: Prisma.TransactionClient, result: TransferResult) => Promise<void>;
  onTransactionCommitted?: () => void;
}

const executions = new AsyncLocalStorage<BankingExecutionContext>();

export function withBankingExecution<T>(context: BankingExecutionContext, run: () => Promise<T>): Promise<T> {
  return executions.run(context, run);
}

export function bankingExecutionContext(): BankingExecutionContext | undefined {
  return executions.getStore();
}
