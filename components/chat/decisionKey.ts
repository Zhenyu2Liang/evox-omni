/**
 * `decisionKey.ts` — a STABLE identity key for a `PendingActionSummary`.
 *
 * Historical `confirmation` metadata and live `pendingAction` share a gated decision identity.
 * After settlement the chat layer stamps runtime-only
 * fields (`status` / `message`) onto the card's `action` object, which changes `JSON.stringify(action)`
 * even though the DECISION is the same. This key ignores those runtime-only fields (as well as the
 * action id, which the summary does not carry) so duplicate suppression and settle-matching keep
 * working across a stamped card.
 */
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { ToolName } from '@/lib/contracts/tools';

/**
 * The summary shapes a decision key is computed for: a plain `PendingActionSummary`, or a variant
 * (e.g. the chat layer's `MfaActionSummary`) whose `toolName` may be absent. Only the decision-bearing
 * fields are read, so the identity is stable across both.
 */
export type DecisionKeyInput = Omit<PendingActionSummary, 'toolName'> & { toolName?: ToolName };

export function decisionKey(action: DecisionKeyInput): string {
  const record = action as unknown as {
    title?: unknown;
    toolName?: unknown;
    tier?: unknown;
    amount?: unknown;
    requiresMfa?: unknown;
    fields?: unknown;
  };
  const fields = Array.isArray(record.fields)
    ? record.fields.map((f) => {
        const field = f as { label?: unknown; value?: unknown } | null;
        return [String(field?.label ?? ''), String(field?.value ?? '')];
      })
    : [];
  return JSON.stringify({
    title: typeof record.title === 'string' ? record.title : '',
    toolName: typeof record.toolName === 'string' ? record.toolName : '',
    tier: typeof record.tier === 'string' ? record.tier : '',
    amount: typeof record.amount === 'string' ? record.amount : null,
    requiresMfa: record.requiresMfa === true,
    fields,
  });
}
