/**
 * Agent — write-audit port.
 *
 * AUDIT BY SIDE EFFECT, NOT BY COLOUR: auditing is decided by whether an operation produces a side
 * effect (`security/permission-engine`'s `ToolPolicy.write`), never by its permission tier. A GREEN
 * auto-executed write (`reserve_budget`) is therefore audited exactly like a gated YELLOW/RED action.
 *
 * The audit row is inserted INSIDE the SAME `prisma.$transaction` as the business write (`strict`), so
 * an audit failure rolls the business write back: no side effect can be committed un-audited. The
 * dedupe key makes the audit write-once per execution identity, so a replay cannot duplicate it; it
 * uses a `write:` prefix that cannot collide with the decision-keyed `exec:<actionId>` /
 * `reconcile:<actionId>` / `manual:<id>:<phase>` identities, which stay intact.
 *
 * Dependency direction: `agent` → `audit` / `security` (+ the `banking-sdk` context TYPE). The SDK
 * never imports this module; the callback travels through `BankingExecutionContext`.
 */
import { recordAudit } from '../audit/audit-logger';
import type { BankingExecutionContext, WriteCommitEvent } from '../banking-sdk/execution-context';
import { demoNow } from '../lib/clock';
import type { ToolName } from '../lib/contracts/tools';
import { getToolPolicy } from '../security/permission-engine';

/** The SDK write-audit hook this module produces. */
export type WriteCommitHook = NonNullable<BankingExecutionContext['onWriteCommit']>;

/** Trusted, server-resolved identity of the caller — never read from model arguments. */
export interface WriteAuditIdentity {
  sessionId: string;
  userRequest: string;
  taskId?: string;
  nodeId?: string;
}

/** Audit dedupe key of one execution identity — `write:<tool>:<owner>:<identity>` (never `exec:`/`reconcile:`). The OWNER is required: the identity may be a per-user LOCAL key (e.g. a budget's `idempotencyKey`), so without the owner two distinct users would collide on the globally-unique `dedupeKey`; same owner + same identity is still the only duplicate. */
export function writeAuditKey(toolName: string, owner: string, identity: string): string {
  return `write:${toolName}:${owner}:${identity}`;
}

/**
 * Build the write-audit hook for one tool invocation. The entry records the ORIGINAL request, the
 * validated tool args, the action/plan/node identifiers, the authorization context (tier + no
 * confirmation/MFA: this is the auto-executed, un-gated write path) and the TRUE persisted result.
 */
export function buildWriteCommitAudit(
  tool: ToolName,
  userId: string,
  identity: WriteAuditIdentity,
): WriteCommitHook {
  const tier = getToolPolicy(tool).tier;
  return async (tx, event: WriteCommitEvent) => {
    await recordAudit(
      {
        timestamp: demoNow(),
        sessionId: identity.sessionId,
        userId,
        userRequest: identity.userRequest,
        intent: event.toolName,
        toolName: event.toolName,
        riskLevel: tier,
        confirmationRequired: false,
        confirmed: false,
        mfaRequired: false,
        toolArgs: event.args,
        toolResult: { ok: true, data: event.data },
        status: 'success',
        detail: `写操作审计（按副作用记录，与业务写入同一事务）：${tool}`,
        ...(identity.taskId !== undefined ? { taskId: identity.taskId } : {}),
        ...(identity.nodeId !== undefined ? { nodeId: identity.nodeId } : {}),
      },
      { client: tx, dedupeKey: writeAuditKey(event.toolName, userId, event.identity), strict: true },
    );
  };
}
