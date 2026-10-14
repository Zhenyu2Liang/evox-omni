/**
 * execution-convergence.ts — the ONE evidence-based convergence decision for a persisted
 * `PendingAction` whose terminal status may not have landed, plus the recovery-audit entry builder.
 *
 * A transfer's debit, ledger, receipt and required audit commit together. Result/status landing is
 * a later transaction. When the side effect COMMITS but status landing fails, the row is left `confirmed` with
 * `resultJson=null` — a WEDGE. Finalizing such a row from `resultJson` ALONE (which is absent) would
 * settle a SUCCESSFUL, irreversible side effect as `failed`. The ONLY sound decision is EVIDENCE-BASED:
 * consult the PERSISTED facts (the committed `ExecutionReceipt`, the stored result, a live lease /
 * in-process continuation) and converge on the truth — NEVER re-invoking the tool on a guess.
 *
 * This module is a DISPATCHER over the durable primitives already owned by `confirmation-recovery.ts`
 * (`isActionLive`, `hasActiveLease`, `summaryFromReceipt`); it owns NO policy and NEVER computes a
 * tier, a confirmation requirement or an MFA requirement.
 */
import type { AuditEntry } from '@/lib/contracts/audit';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import { safeParse } from '@/lib/json';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import type { ToolExecutionResult } from './tools';
import { hasActiveLease, isActionLive, leaseNowMs } from './confirmation-recovery';
import { committedExecutionResult } from './execution-evidence';

/**
 * The terminal manual-review outcome for a PLAN-LINKED wedge whose side effect is UNKNOWN (no
 * receipt, no stored result). The tool is NEVER re-invoked: re-running a tool that does not consume
 * the SDK idempotency key (e.g. `set_card_limit`) would RE-APPLY its side effect. The owning node is
 * stopped with this message; the action is `needs_reconciliation`, not a fabricated failure.
 *
 * The exact string is a frozen contract (asserted by
 * `tests/integration/node-result-recovery.test.ts`); do NOT reword it.
 */
export const PLAN_LINKED_UNRECONCILED_ERROR =
  '该节点此前已执行但未留存结果，需人工核对（不会重新执行）。';

/**
 * The persisted `PendingAction` fields the convergence decision reads — a structural slice of the
 * row returned by `getPendingAction` / `listPendingActionsByTask` (both select every column).
 */
export interface ConvergenceActionRow {
  id: string;
  userId: string;
  sessionId: string;
  taskId: string | null;
  nodeId: string | null;
  status: string;
  resultJson: string | null;
  toolName: string;
  argsJson: string;
  riskLevel: string;
  requiresMfa: boolean;
  userRequest: string | null;
  intent: string | null;
  executionLeaseOwner: string | null;
  executionLeaseExpiresAt: Date | null;
  mfa?: { status: string } | null;
}

/** The PERSISTED evidence the decision was based on (`none` = no usable proof). */
export type ConvergenceEvidence = 'committed' | 'stored' | 'live' | 'none';

/** The convergence decision: the terminal status to land on, the result to (back)fill, and whether a write is required. */
export interface ConvergenceDecision {
  status: PendingActionStatus;
  /** Result to persist/backfill — REUSED evidence; NEVER produced by re-running the tool. */
  result?: ToolExecutionResult;
  evidence: ConvergenceEvidence;
  /** Whether a settle/backfill write is required (false = leave the persisted row untouched). */
  write: boolean;
}

/** Manual-review decisions are separate events; never overwrite a committed execution audit. */
export function convergenceAuditKey(actionId: string, status: PendingActionStatus): string {
  return status === 'needs_reconciliation' ? `reconcile:${actionId}` : `exec:${actionId}`;
}

/** A plan link is USABLE only when BOTH `taskId` and `nodeId` are non-null and non-empty. */
function isPlanLinked(action: ConvergenceActionRow): boolean {
  const taskId = action.taskId?.trim();
  const nodeId = action.nodeId?.trim();
  return taskId !== undefined && taskId !== '' && nodeId !== undefined && nodeId !== '';
}

/** Decode the durable execution result stored on a row's `resultJson` (mirrors `readStoredResult`). */
function readStored(resultJson: string | null): ToolExecutionResult | undefined {
  const parsed = safeParse<Partial<ToolExecutionResult> | null>(resultJson, null);
  if (parsed === null || typeof parsed.ok !== 'boolean') return undefined;
  return { ok: parsed.ok, data: parsed.data, summary: parsed.summary, error: parsed.error };
}

/**
 * Decide how a persisted `PendingAction` must converge, from PERSISTED FACTS ONLY (priority order):
 *
 * 1. A verified current receipt and its committed business evidence prove success.
 * 2. A normal completion uses the same decision. Lost results after a committed SDK transaction
 *    require reconciliation unless persisted evidence above proves the actual outcome.
 * 3. Live markers/persisted leases defer recovery; stored results are reused without re-execution.
 * 4. A plan-linked unknown outcome becomes `needs_reconciliation`; the node stops for manual review.
 *    Standalone unknowns defer to receipt-first/idempotent recovery, never to an unkeyed retry.
 *
 * A genuinely UNDECIDED row (`pending`/`awaiting_mfa`) is NEVER converged — it still awaits the human.
 */
export async function decideConvergence(
  action: ConvergenceActionRow,
  opts?: { nowMs?: number; completion?: ToolExecutionResult; sideEffectCommitted?: boolean },
): Promise<ConvergenceDecision> {
  // A row still awaiting the human decision is NOT a wedge — never finalize it.
  if (action.status === 'pending' || action.status === 'awaiting_mfa') {
    return { status: action.status, evidence: 'live', write: false };
  }

  const planLinked = isPlanLinked(action);

  // 1. COMMITTED SUCCESSFUL SIDE EFFECT — the durable proof, consulted BEFORE any mutable lookup.
  let committed: ToolExecutionResult | undefined;
  try {
    committed = await committedExecutionResult(action);
  } catch (error) {
    // Conflicting/corrupt execution evidence is UNKNOWN, never proof of failure. Database read
    // failures must propagate so callers cannot overwrite an outcome they could not inspect.
    if (!(error instanceof AppError) || error.code !== 'CONFLICT') throw error;
    return { status: 'needs_reconciliation', result: { ok: false, error: error.message }, evidence: 'none', write: true };
  }
  if (committed !== undefined) {
    return { status: 'executed', result: committed, evidence: 'committed', write: true };
  }

  // Normal confirm/MFA uses the same evidence decision as recovery, before landing an outcome.
  // SDK writes all enter the observed transaction boundary. A committed write followed by a lost
  // return value is unknown unless a receipt/ledger above proves its actual result.
  if (opts?.completion !== undefined) {
    const unknown = !opts.completion.ok && opts.sideEffectCommitted === true;
    return { status: unknown ? 'needs_reconciliation' : opts.completion.ok ? 'executed' : 'failed',
      result: opts.completion, evidence: 'stored', write: true };
  }

  // 2. LIVE holder — a continuation is applying (or about to apply) this side effect right now.
  const nowMs = opts?.nowMs ?? leaseNowMs();
  const live = isActionLive(action.id) || hasActiveLease(action, nowMs);
  if (live) {
    return { status: 'confirmed', evidence: 'live', write: false };
  }

  // 3. PERSISTED RESULT — the atomic result+status write DID land (or a prior recovery settled it).
  const stored = readStored(action.resultJson);
  if (stored !== undefined) {
    return {
      status: stored.ok ? 'executed' : 'failed',
      result: stored,
      evidence: 'stored',
      write: action.status === 'confirmed',
    };
  }

  // 4. NO PROOF.
  if (planLinked) {
    // NEVER re-run a plan node's tool on a guess; settle it TERMINALLY for manual review.
    return {
      status: 'needs_reconciliation',
      result: { ok: false, error: PLAN_LINKED_UNRECONCILED_ERROR },
      evidence: 'none',
      write: true,
    };
  }
  // A STANDALONE wedge is left to `recoverStandaloneWedge` (receipt-first replay / `needs_reconciliation`).
  return { status: 'confirmed', evidence: 'none', write: false };
}

/**
 * Build the execution `AuditEntry` for a convergence-dispatch settle that lands a terminal status
 * from COMMITTED EVIDENCE (a receipt or a stored result). Written INSIDE the same `$transaction` as
 * the result+status write (via `settlePendingAction`). `convergenceAuditKey` uses `exec:<actionId>`
 * for execution and `reconcile:<actionId>` for manual review, preserving both events on a conflict.
 */
export function buildRecoveryAudit(
  action: ConvergenceActionRow,
  decision: ConvergenceDecision,
): AuditEntry {
  const ok = decision.result?.ok === true;
  return {
    timestamp: demoNow(),
    sessionId: action.sessionId,
    userId: action.userId,
    userRequest: action.userRequest ?? '',
    intent: action.intent ?? undefined,
    toolName: action.toolName,
    riskLevel: (action.riskLevel as RiskLevel | undefined) ?? 'YELLOW',
    confirmationRequired: true,
    confirmed: true,
    mfaRequired: action.requiresMfa === true,
    mfaResult: action.requiresMfa ? action.mfa?.status === 'verified' ? 'success' : undefined : 'not_required',
    toolArgs: safeParse<Record<string, unknown>>(action.argsJson, {}),
    taskId: action.taskId ?? undefined,
    nodeId: action.nodeId ?? undefined,
    toolResult: decision.result,
    status: decision.status === 'needs_reconciliation' ? 'blocked' : ok ? 'success' : 'failed',
    detail: decision.status === 'needs_reconciliation'
      ? '恢复：执行证据缺失或矛盾，已进入人工核对（未重新执行副作用）'
      : '恢复：由已提交的执行证据判定终态（未重新执行副作用）',
  };
}
