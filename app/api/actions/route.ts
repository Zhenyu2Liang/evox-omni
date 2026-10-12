/**
 * GET /api/actions — the caller session's SURFACED pending actions.
 *
 * This is the frozen endpoint the UI consumes to RESTORE the confirm/MFA entry after a page
 * refresh: it lists every `PendingAction` that still needs the human's attention for the caller's
 * session.
 *
 * Contract:
 *  - IDENTITY: the session comes from the TRUSTED `banking_session` cookie
 *    (`_lib/session#requireIdentity`); a missing cookie or unknown session → `403 SECURITY_DENIED`.
 *    A `?sessionId=` query param is IGNORED — a caller can never read another session's actions.
 *  - Reads the caller session's `PendingAction` rows via the sanctioned repository read path
 *    (`@/lib/db/repositories/pendingAction#listPendingActions`) and keeps only the SURFACED ones:
 *      • the two NON-TERMINAL statuses that await a human decision (`pending`, `awaiting_mfa`);
 *      • the TERMINAL `needs_reconciliation` manual-reconciliation entry (a gated side effect that
 *        may have committed but whose outcome could not be recorded/recovered);
 *      • a `confirmed` row that is NOT `settled` per `classifyConfirmedAction` — i.e. a STRANDED
 *        wedge (the result+status write never committed) that a plain refresh would otherwise hide
 *        forever: `processing` (an in-flight continuation holds a live persisted lease),
 *        `recoverable` (a confirmed, result-less row whose tool may be safely recovered), or
 *        `needs_reconciliation` (a confirmed, result-less row whose tool must be settled manually).
 *        A `confirmed` row that IS `settled` (it has a persisted result) needs no attention and
 *        stays HIDDEN.
 *  - Each returned item carries an additive, advisory `attention` classification
 *    (`'decision' | 'processing' | 'recoverable' | 'reconciliation'`) so the UI can render
 *    处理中 / 可恢复 / 待人工核对 without re-deriving the state.
 *  - Maps each row to the frozen `PendingAction` contract (JSON columns decoded with `safeParse`,
 *    timestamps as epoch ms). The response is JSON-serializable and NEVER contains the MFA code.
 *  - Success: `200 { ok: true, data: SurfacedPendingAction[] }` (newest-first).
 *
 * READ-ONLY by design: classification reads PERSISTED columns (+ the lease clock) only — no write,
 * no side effect, no tool execution. Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { withActionPolicy } from '@/lib/action-summary';
import type { PendingAction as PendingActionRow } from '@prisma/client';
import {
  listPendingActions,
} from '@/lib/db/repositories/pendingAction';
import {
  classifyConfirmedAction,
  leaseNowMs,
} from '@/agent';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import type { PendingAction, PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import { safeParse } from '@/lib/json';
import { errorResponse, jsonResponse } from '../_lib/http';
import { requireIdentity } from '../_lib/session';
import type { ActionAttention, SurfacedPendingAction } from '../_lib/types';

/**
 * The TWO non-terminal statuses this endpoint surfaces UNCONDITIONALLY — the human still has to
 * decide on them (`pending`/`awaiting_mfa`) plus the TERMINAL `needs_reconciliation` entry, which
 * still requires user attention. A `confirmed` row is handled separately (see {@link attentionFor})
 * because it is surfaced ONLY when it is NOT settled.
 */
const DECISION_STATUSES: readonly PendingActionStatus[] = ['pending', 'awaiting_mfa', 'needs_reconciliation'];

/** Safe summary fallback when a row's `summaryJson` is missing/corrupt (never leaks anything). */
const FALLBACK_SUMMARY: PendingActionSummary = {
  title: '待处理操作',
  toolName: 'get_balance',
  tier: 'GREEN',
  fields: [],
  requiresMfa: false,
};

/**
 * Classify a persisted row into its ATTENTION class, or `undefined` when it needs NO attention.
 *
 * `pending`/`awaiting_mfa` → `decision`; `needs_reconciliation` → `reconciliation`. A `confirmed`
 * row is delegated to `classifyConfirmedAction`: a `settled` row needs no attention (`undefined`),
 * a `processing`/`recoverable`/`needs_reconciliation` one is surfaced with its matching class.
 * Any other status (executed / failed / cancelled / locked) is settled → `undefined`. Pure read.
 */
function attentionFor(row: PendingActionRow, nowMs: number): ActionAttention | undefined {
  const status = row.status as PendingActionStatus;
  if (status === 'pending' || status === 'awaiting_mfa') return 'decision';
  if (status === 'needs_reconciliation') return 'reconciliation';
  if (status !== 'confirmed') return undefined;
  switch (classifyConfirmedAction(row, nowMs)) {
    case 'settled':
      return undefined;
    case 'processing':
      return 'processing';
    case 'recoverable':
      return 'recoverable';
    default:
      return 'reconciliation';
  }
}

/** Map a persisted `PendingAction` row to the frozen, JSON-serializable `PendingAction` contract. */
function toContractPendingAction(row: PendingActionRow): PendingAction {
  const toolName = row.toolName as ToolName;
  const tier = row.riskLevel as RiskLevel;
  const parsedSummary = safeParse<PendingActionSummary>(row.summaryJson, FALLBACK_SUMMARY);
  const summary: PendingActionSummary = withActionPolicy({
    actionId: row.id,
    ...parsedSummary,
    toolName,
    tier,
    requiresMfa: row.requiresMfa,
  }, { actionId: row.id, tier, requiresMfa: row.requiresMfa });
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolName,
    args: safeParse<Record<string, unknown>>(row.argsJson, {}),
    tier,
    requiresMfa: row.requiresMfa,
    status: row.status as PendingActionStatus,
    summary,
    userRequest: row.userRequest ?? undefined,
    intent: row.intent ?? undefined,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    // Trusted identity: cookie-only, server-validated. Missing cookie / unknown session → 403.
    const identity = await requireIdentity(req);

    // ONE clock sample for the whole page so every row is classified against the same instant.
    const nowMs = leaseNowMs();

    const rows = await listPendingActions({ sessionId: identity.sessionId });
    const actions: SurfacedPendingAction[] = [];
    for (const row of rows) {
      const attention = attentionFor(row, nowMs);
      if (attention === undefined) continue;
      actions.push({ ...toContractPendingAction(row), attention });
    }

    return jsonResponse<SurfacedPendingAction[]>(actions);
  } catch (e) {
    return errorResponse(e);
  }
}

// (no value re-export: route modules may only export route handlers + type-only exports)
export type { PendingAction, SurfacedPendingAction, ActionAttention };
