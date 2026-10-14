import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@/lib/db/prisma';
import type { ExecutionFenceCheck } from './fence';
import type { TransferResult } from './types';

/**
 * A committed SIDE EFFECT that must be audited, described by the write site that produced it.
 * The SDK never builds an `AuditEntry` itself (no `audit` dependency) — it hands these facts to the
 * trusted server callback below, which composes the audit row INTO the same transaction.
 */
export interface WriteCommitEvent {
  /** Registered tool that produced the side effect. */
  toolName: string;
  /**
   * Stable identity of THIS execution: the idempotency key when the caller supplied one (a replay of
   * the same identity writes nothing and therefore audits nothing), else the created row id.
   */
  identity: string;
  /** Validated tool arguments that produced the write. */
  args: Record<string, unknown>;
  /** The persisted result data (the true outcome). */
  data: unknown;
}

/** Trusted server callbacks, scoped to one invocation; never read from model arguments. */
export interface BankingExecutionContext {
  sessionId?: string;
  fence?: ExecutionFenceCheck;
  onTransferCommit?: (tx: Prisma.TransactionClient, result: TransferResult) => Promise<void>;
  /**
   * Write-audit hook: awaited INSIDE the SAME `prisma.$transaction` as the business write, so a
   * throwing/failing audit rolls the write back. A side effect can therefore never be committed
   * un-audited, and an audited operation never invents a side effect it did not produce.
   */
  onWriteCommit?: (tx: Prisma.TransactionClient, event: WriteCommitEvent) => Promise<void>;
  onTransactionCommitted?: () => void;
}

const executions = new AsyncLocalStorage<BankingExecutionContext>();

export function withBankingExecution<T>(context: BankingExecutionContext, run: () => Promise<T>): Promise<T> {
  return executions.run(context, run);
}

export function bankingExecutionContext(): BankingExecutionContext | undefined {
  return executions.getStore();
}
