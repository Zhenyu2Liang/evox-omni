/**
 * execution-convergence.ts — the ONE evidence-based convergence decision for a persisted
 * `PendingAction` whose terminal status may not have landed, plus the recovery-audit entry builder.
 *
 * WHY THIS MODULE: a gated action's side effect (SDK write) and its result+status+audit landing are
 * two DIFFERENT transactions. When the side effect COMMITS but the landing transaction ROLLS BACK (a
 * transient audit/status-write failure, or a process death), the row is left `confirmed` with
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
import { getExecutionReceipt } from '@/lib/db/repositories/executionReceipt';
import { ledgerKeyForAction } from '@/lib/ledger';
import { safeParse } from '@/lib/json';
import { demoNow } from '@/lib/clock';
import type { ToolExecutionResult } from './tools';
import { hasActiveLease, isActionLive, leaseNowMs, summaryFromReceipt } from './confirmation-recovery';

/**
 * The terminal manual-review outcome for a PLAN-LINKED wedge whose side effect is UNKNOWN (no
 * receipt, no stored result). The tool is NEVER re-invoked: re-running a tool that does not consume
 * the SDK idempotency key (e.g. `set_card_limit`) would RE-APPLY its side effect. The owning node is
 * settled TERMINALLY `failed` with this exact message so the plan settles instead of wedging.
 *
 * The exact string is a frozen contract (asserted by `tests/review-result-recovery.test.ts` and
 * `tests/review-next-boundaries.test.ts`); do NOT reword it.
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
  riskLevel: string;
  requiresMfa: boolean;
  userRequest: string | null;
  intent: string | null;
  executionLeaseOwner: string | null;
  executionLeaseExpiresAt: Date | null;
}

/** The PERSISTED evidence the decision was based on (`none` = no usable proof). */
export type ConvergenceEvidence = 'receipt' | 'stored' | 'live' | 'none';

/** The convergence decision: the terminal status to land on, the result to (back)fill, and whether a write is required. */
export interface ConvergenceDecision {
  status: PendingActionStatus;
  /** Result to persist/backfill — REUSED evidence; NEVER produced by re-running the tool. */
  result?: ToolExecutionResult;
  evidence: ConvergenceEvidence;
  /** Whether a settle/backfill write is required (false = leave the persisted row untouched). */
  write: boolean;
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
 * 1. `receipt`  — a committed `ExecutionReceipt` for this execution identity proves the side effect
 *                 ALREADY ran: converge `executed`, REUSING the receipt's stored result snapshot
 *                 (never re-running the tool). Also recognizes a pre-receipt LEGACY ledger row is out
 *                 of scope here (the SDK replay handles it); the receipt is the durable proof.
 * 2. `live`     — a live in-process continuation (`isActionLive`) OR — for a STANDALONE row only — an
 *                 active persisted EXECUTION LEASE owns the row: it is result-less only because the
 *                 holder has not written yet. Leave it `confirmed` (no write). A PLAN-LINKED row is
 *                 treated as live ONLY by the in-process marker (its persisted lease is ambiguous).
 * 3. `stored`   — a persisted `resultJson` decodes: converge on its `ok` (`executed`/`failed`).
 * 4. `none`     — no proof: a PLAN-LINKED row settles TERMINALLY `failed` with
 *                 {@link PLAN_LINKED_UNRECONCILED_ERROR} (manual review, never re-run); a STANDALONE
 *                 row is DEFERRED (`write:false`) to the existing `recoverStandaloneWedge` path,
 *                 which replays a PROVEN-idempotent tool or routes to `needs_reconciliation`.
 *
 * A genuinely UNDECIDED row (`pending`/`awaiting_mfa`) is NEVER converged — it still awaits the human.
 */
export async function decideConvergence(
  action: ConvergenceActionRow,
  opts?: { nowMs?: number },
): Promise<ConvergenceDecision> {
  // A row still awaiting the human decision is NOT a wedge — never finalize it.
  if (action.status === 'pending' || action.status === 'awaiting_mfa') {
    return { status: action.status, evidence: 'live', write: false };
  }

  const planLinked = isPlanLinked(action);

  // 1. COMMITTED SUCCESSFUL SIDE EFFECT — the durable proof, consulted BEFORE any mutable lookup.
  const key = ledgerKeyForAction({
    id: action.id,
    taskId: action.taskId ?? undefined,
    nodeId: action.nodeId ?? undefined,
  });
  const receipt = await getExecutionReceipt(action.userId, key);
  if (receipt !== null) {
    const stored = safeParse<Record<string, unknown> | null>(receipt.resultJson, null);
    if (stored !== null) {
      return {
        status: 'executed',
        result: {
          ok: true,
          data: stored,
          summary: summaryFromReceipt(action.toolName, stored),
        },
        evidence: 'receipt',
        write: action.status !== 'executed',
      };
    }
  }

  // 2. LIVE holder — a continuation is applying (or about to apply) this side effect right now.
  const nowMs = opts?.nowMs ?? leaseNowMs();
  const live = isActionLive(action.id) || (!planLinked && hasActiveLease(action, nowMs));
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
      status: 'failed',
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
 * the result+status write (via `settlePendingAction`) with the `exec:<actionId>` dedupe key, so a
 * repeat recovery never double-records and an action can never settle `executed` without its audit.
 */
export function buildRecoveryAudit(
  action: ConvergenceActionRow,
  decision: ConvergenceDecision,
): AuditEntry {
  const ok = decision.result?.ok === true;
  return {
    timestamp: demoNow(),
    sessionId: action.sessionId,
    userRequest: action.userRequest ?? '',
    intent: action.intent ?? undefined,
    toolName: action.toolName,
    riskLevel: (action.riskLevel as RiskLevel | undefined) ?? 'YELLOW',
    confirmationRequired: true,
    confirmed: true,
    mfaRequired: action.requiresMfa === true,
    toolResult: decision.result,
    status: ok ? 'success' : 'failed',
    detail: '恢复：由已提交的执行证据判定终态（未重新执行副作用）',
  };
}
