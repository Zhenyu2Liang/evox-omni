/**
 * GET /api/actions — the caller session's SURFACED pending actions.
 *
 * This is the frozen endpoint the UI consumes to RESTORE the confirm/MFA entry after a page
 * refresh: it lists every `PendingAction` that still needs the human's attention for the caller's
 * session — either a decision (`pending`/`awaiting_mfa`) or a manual-reconciliation entry
 * (`needs_reconciliation`).
 *
 * Contract:
 *  - IDENTITY: the session comes from the TRUSTED `banking_session` cookie
 *    (`_lib/session#requireIdentity`); a missing cookie or unknown session → `403 SECURITY_DENIED`.
 *    A `?sessionId=` query param is IGNORED — a caller can never read another session's actions.
 *  - Reads the caller session's `PendingAction` rows via the sanctioned repository read path
 *    (`@/lib/db/repositories/pendingAction#listPendingActions`) and keeps only the SURFACED ones
 *    (`SURFACED_STATUSES` ∈ {`pending`, `awaiting_mfa`, `needs_reconciliation`}): the two
 *    NON-TERMINAL statuses that await a human decision, plus the TERMINAL `needs_reconciliation`
 *    manual-reconciliation entry (a gated side effect that may have committed but whose outcome
 *    could not be recorded/recovered) — which still requires user attention.
 *  - Maps each row to the frozen `PendingAction` contract (JSON columns decoded with `safeParse`,
 *    timestamps as epoch ms). The response is JSON-serializable and NEVER contains the MFA code.
 *  - Success: `200 { ok: true, data: PendingAction[] }` (newest-first).
 *
 * Thin by design: `validate (zod) → delegate → serialize`. No business logic, no Prisma writes.
 */
import type { NextRequest } from 'next/server';
import type { PendingAction as PendingActionRow } from '@prisma/client';
import {
  listPendingActions,
} from '@/lib/db/repositories/pendingAction';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { ToolName } from '@/lib/contracts/tools';
import type { PendingAction, PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import { safeParse } from '@/lib/json';
import { errorResponse, jsonResponse } from '../_lib/http';
import { requireIdentity } from '../_lib/session';

/**
 * The statuses this endpoint SURFACES — everything the human still has to act on.
 *
 * `pending`/`awaiting_mfa` are NON-TERMINAL: the action is still awaiting a human decision.
 * `needs_reconciliation` is TERMINAL but still REQUIRES user attention: it is the
 * manual-reconciliation entry for a gated side effect that may already have committed but whose
 * outcome could not be recorded/recovered — it must stay visible until a human settles it.
 */
const SURFACED_STATUSES: readonly PendingActionStatus[] = ['pending', 'awaiting_mfa', 'needs_reconciliation'];

/** Safe summary fallback when a row's `summaryJson` is missing/corrupt (never leaks anything). */
const FALLBACK_SUMMARY: PendingActionSummary = {
  title: '待处理操作',
  toolName: 'get_balance',
  tier: 'GREEN',
  fields: [],
  requiresMfa: false,
};

/** Map a persisted `PendingAction` row to the frozen, JSON-serializable `PendingAction` contract. */
function toContractPendingAction(row: PendingActionRow): PendingAction {
  const toolName = row.toolName as ToolName;
  const tier = row.riskLevel as RiskLevel;
  const parsedSummary = safeParse<PendingActionSummary>(row.summaryJson, FALLBACK_SUMMARY);
  const summary: PendingActionSummary = {
    ...parsedSummary,
    toolName,
    tier,
    requiresMfa: row.requiresMfa,
  };
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

    const rows = await listPendingActions({ sessionId: identity.sessionId });
    const actions = rows
      .filter((row) => SURFACED_STATUSES.includes(row.status as PendingActionStatus))
      .map(toContractPendingAction);

    return jsonResponse<PendingAction[]>(actions);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { PendingAction };
