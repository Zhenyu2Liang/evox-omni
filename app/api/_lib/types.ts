/**
 * app/api/_lib/types.ts — app-layer transport types shared by every route handler.
 *
 * These are APP-LAYER types (the HTTP response envelope + route response shapes). They live in
 * this private `_`-folder rather than `@/lib/contracts` because they describe the HTTP edge, not
 * the domain. `_lib` is a Next.js private folder (leading underscore) — it never becomes a route.
 *
 * Nothing outside `app/api/**` should import this module.
 */
import type { ErrorCode } from '@/lib/errors';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingAction, PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';

/** Success envelope returned by every route: `{ ok: true, data }`. */
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

/** Error payload carried inside a failure envelope: `{ code, message }`. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
}

/** Failure envelope returned by every route: `{ ok: false, error: { code, message } }`. */
export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

/** The envelope EVERY API route returns (success or failure). */
export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

/**
 * Result of an action (confirm / verify / cancel) route.
 *
 * `ok` describes the DOMAIN outcome (was the action authorized/executed?), NOT the HTTP status —
 * a wrong MFA code or a cancelled action is a normal `200` response with `ok:false`. `events`
 * carries the agent continuation events (the model narrates the factual outcome) the client
 * appends to the chat. `message` is always safe/user-facing and NEVER contains the MFA code.
 */
export interface ActionResponse {
  actionId: string;
  sessionId: string;
  /** True iff the action is now authorized/executed. */
  ok: boolean;
  status: PendingActionStatus;
  tier: RiskLevel;
  requiresMfa: boolean;
  mfaResult?: 'success' | 'failed' | 'not_required';
  /** Safe, user-facing text. Never contains the MFA code. */
  message: string;
  /** Continuation events to append to the chat stream. */
  events: AgentStreamEvent[];
}

/**
 * The ATTENTION class of a surfaced `PendingAction` (a `GET /api/actions` row) — an app-layer,
 * purely ADVISORY classification the UI uses to pick the right card:
 *  - `decision`       — `pending` / `awaiting_mfa`: awaits a human decision (confirm / MFA code).
 *  - `processing`     — a `confirmed`, result-less row with a NON-EXPIRED persisted execution lease:
 *                       an in-flight continuation owns it and is applying the side effect right now.
 *  - `recoverable`    — a `confirmed`, result-less row whose tool may be safely RECOVERED (its
 *                       side effect may be replayed / read back from a committed receipt).
 *  - `reconciliation` — a `needs_reconciliation` row (or a `confirmed`, result-less row whose tool
 *                       is NOT safely recoverable): the outcome is UNKNOWN and needs manual settling.
 */
export type ActionAttention = 'decision' | 'processing' | 'recoverable' | 'reconciliation';

/**
 * A `GET /api/actions` row: the frozen `PendingAction` contract PLUS the app-layer `attention`
 * classification. Strictly ADDITIVE — every frozen `PendingAction` field is preserved untouched so
 * existing consumers keep working; `attention` is a hint only and never grants/lifts anything.
 */
export type SurfacedPendingAction = PendingAction & { attention: ActionAttention };

/**
 * Next.js 15 dynamic-route context: `params` is a Promise that resolves to the path segments.
 * Route handlers typed `(req, ctx: IdRouteContext)` read the id via `(await ctx.params).id`.
 */
export interface IdRouteContext {
  params: Promise<{ id: string }>;
}
