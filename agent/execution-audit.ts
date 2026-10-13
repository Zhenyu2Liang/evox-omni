import { recordAudit } from '@/audit';
import { demoNow } from '@/lib/clock';
import type { AuditEntry } from '@/lib/contracts/audit';
import type { BankingExecutionContext } from '@/banking-sdk';
import type { ToolExecutionResult } from './tools';
import type { Prisma } from '@prisma/client';

/** Compose the required execution audit into a transfer's own transaction, without SDK policy. */
export function transferExecutionAudit(actionId: string, entry: Omit<AuditEntry, 'timestamp' | 'toolResult' | 'status'>) {
  let auditFailure: unknown;
  const onTransferCommit: BankingExecutionContext['onTransferCommit'] = async (tx, data) => {
    try {
      await recordAudit({ ...entry, timestamp: demoNow(), status: 'success', toolResult: { ok: true, data } },
        { client: tx, dedupeKey: `exec:${actionId}`, strict: true });
    } catch (error) {
      auditFailure = error;
      throw error;
    }
  };
  return {
    onTransferCommit,
    onCommandCommit: async (tx: Prisma.TransactionClient, result: ToolExecutionResult) => {
      try {
        await recordAudit({ ...entry, timestamp: demoNow(), status: 'success', toolResult: result },
          { client: tx, dedupeKey: `exec:${actionId}`, strict: true });
        await tx.mfaChallenge.updateMany({ where: { actionId, status: 'verified', consumedAt: null },
          data: { consumedAt: new Date() } });
      } catch (error) { auditFailure = error; throw error; }
    },
    // Tool runners convert SDK exceptions to error results. A required-audit failure must still
    // propagate to HTTP and leave the authorized action recoverable after its transaction rolled back.
    assertSucceeded() { if (auditFailure !== undefined) throw auditFailure; },
  };
}
