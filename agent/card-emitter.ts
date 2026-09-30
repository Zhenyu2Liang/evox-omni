/**
 * card-emitter.ts — the CONTRACT mapping a tool's raw result → `ChatCard`(s).
 * `toCards` is PURE and TOTAL: one case per banking tool family, mapping `ToolExecutionResult` to the
 * `ChatCard` union (balance/transfer/spending/cards/investments/subscriptions/anomaly/plan/error).
 * Unrecognised tool or malformed result ⇒ a single `error` card. Cards are the ONLY way tool data
 * reaches the UI — model prose is never turned into a card.
 */
import type { ChatCard } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { ToolExecutionResult } from './tools';

/** Map a tool result to zero or more chat cards. PURE + total (unknown ⇒ [{type:'error'}]). */
export function toCards(toolName: ToolName, result: ToolExecutionResult): ChatCard[] {
  throw new Error('not implemented');
}
/** A standalone error card. PURE. */
export function errorCard(message: string): ChatCard {
  throw new Error('not implemented');
}
/** A confirmation card from a pending-action summary. PURE. */
export function confirmationCard(action: PendingActionSummary): ChatCard {
  throw new Error('not implemented');
}
/** An MFA-required card. PURE. */
export function mfaCard(actionId: string, hint?: string): ChatCard {
  throw new Error('not implemented');
}
