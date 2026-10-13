import type { ExecutionReceipt } from '@prisma/client';
import { type Prisma } from '@prisma/client';
import { dbClient } from '../client';

/**
 * Repository for the unified `ExecutionReceipt` aggregate — the durable proof that a gated side
 * effect with a given execution identity (`userId` + `key`) ALREADY COMMITTED.
 *
 * TRANSACTION COMPOSABILITY — every function takes an OPTIONAL trailing
 * `client: Prisma.TransactionClient = prisma`, mirroring `pendingAction.ts`. The default is the
 * shared singleton; passing an explicit client (a `prisma.$transaction` handle) routes the access
 * through it so a caller can write the receipt in the SAME transaction as the side effect it
 * records (the debit + ledger row) — the two then commit together or roll back together.
 */

export interface PutExecutionReceiptInput {
  id: string;
  userId: string;
  key: string;
  toolName: string;
  /** Canonical fingerprint of the original request (see `@/lib/ledger#requestDigest`). */
  requestDigest: string;
  /** JSON text of the ORIGINAL result snapshot (replayed verbatim under the same identity). */
  resultJson: string;
  /** The ledger row this receipt is linked to, when the tool writes one. */
  txId?: string | null;
}

/** The receipt recorded for `(userId, key)`, or `null` when nothing has committed yet. */
export function getExecutionReceipt(
  userId: string,
  key: string,
  client: Prisma.TransactionClient = dbClient(),
): Promise<ExecutionReceipt | null> {
  return client.executionReceipt.findUnique({ where: { userId_key: { userId, key } } });
}

/**
 * Persist a receipt. A unique violation (`P2002`) on either `id` or `(userId, key)` is NOT caught
 * here — it surfaces to the caller, which recognizes the already-committed fact (a concurrent
 * same-key winner) and replays it instead of treating the call as a failure.
 */
export function putExecutionReceipt(
  input: PutExecutionReceiptInput,
  client: Prisma.TransactionClient = dbClient(),
): Promise<ExecutionReceipt> {
  return client.executionReceipt.create({
    data: {
      id: input.id,
      userId: input.userId,
      key: input.key,
      toolName: input.toolName,
      requestDigest: input.requestDigest,
      resultJson: input.resultJson,
      ...(input.txId !== undefined ? { txId: input.txId } : {}),
    },
  });
}
