/**
 * `decision-record.ts` — the ONE projection from a persisted `PendingAction` row to its
 * conversation card.
 *
 * State authority lives in the persisted row, never in the card: `status` is copied verbatim, the
 * summary and policy are re-resolved from the row's CURRENT columns, and nothing here writes a row.
 * Two consequences make a locked action safe after a refresh / history restore:
 *
 *  - The card KEEPS the shape the live stream used (`mfa` for a verification request,
 *    `confirmation` for a plain approval). A refresh therefore shows the same card the browser
 *    already rendered for that action — a locked verification does not turn into a different kind of
 *    card mid-life, which would be its own state-authority bug.
 *  - The card ALWAYS carries the persisted `status` (including for an open `awaiting_mfa` row). That
 *    stamp is what makes the transcript card read as settled, and the interactive confirmation/MFA
 *    panel — which lives in the client's decision dock, not in the transcript — may only be rebuilt
 *    from a row that is still `pending`/`awaiting_mfa` (see {@link isOpenDecision}). A settled
 *    transcript card additionally fences a stale server row out of that dock.
 *
 * Once settled, a card also drops its verification `hint`: a locked/closed request must not carry
 * the prompt for the code it will never accept again.
 */
import type { ChatCard } from '@/lib/contracts/agent';
import type { PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import type { RiskLevel } from '@/lib/contracts/risk';
import { withActionPolicy } from '@/lib/action-summary';
import { safeParse } from '@/lib/json';

/** The persisted columns a projection reads. Terminal rows are projected exactly like open ones. */
export interface DecisionRow {
  id: string;
  riskLevel: string;
  requiresMfa: boolean;
  summaryJson: string;
  status: string;
}

type VerificationCard = Extract<ChatCard, { type: 'mfa' }>;
type ApprovalCard = Extract<ChatCard, { type: 'confirmation' }>;

/**
 * The ONLY statuses a live decision may still be rebuilt from. Every other status — `locked`
 * included — is a settled record that can never become an interactive verification panel again.
 */
export function isOpenDecision(status: string): boolean {
  return status === 'pending' || status === 'awaiting_mfa';
}

/**
 * Re-resolve a row's public summary from its persisted JSON, keeping `fallback` (the card's own
 * stored summary) when the column is unusable. Returns `undefined` rather than inventing a summary
 * when neither source is renderable, so a corrupt row degrades to the stored card instead of
 * poisoning the whole history page.
 */
export function decisionSummary(row: DecisionRow, fallback?: PendingActionSummary): PendingActionSummary | undefined {
  const stored = safeParse<PendingActionSummary | undefined>(row.summaryJson, fallback);
  if (!stored || typeof stored.title !== 'string' || !Array.isArray(stored.fields)) return undefined;
  return withActionPolicy(stored, { actionId: row.id, tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa });
}

/**
 * The verification record of a row, carrying its persisted status. `hint` survives only while the
 * row is still open; `message` is the row's settlement reason and survives only once it is settled.
 */
export function verificationCard(row: DecisionRow, action: PendingActionSummary,
  stored: { hint?: string; message?: string } = {}): VerificationCard {
  const open = isOpenDecision(row.status);
  return { type: 'mfa', actionId: row.id, action, status: row.status as PendingActionStatus,
    ...(open && stored.hint !== undefined ? { hint: stored.hint } : {}),
    ...(!open && stored.message !== undefined ? { message: stored.message } : {}) };
}

/** The plain-approval record of a row; the persisted status rides on the action, as the client reads it. */
export function approvalCard(row: DecisionRow, action: PendingActionSummary): ApprovalCard {
  return { type: 'confirmation', action: { ...action, status: row.status } as PendingActionSummary };
}
