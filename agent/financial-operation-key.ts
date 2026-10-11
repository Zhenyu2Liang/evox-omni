import type { FactInput } from './grounding-facts';

/** Identity supplied by the server execution path, never inferred from an assistant sentence. */
export function financialOperationKey(entry: FactInput): string | undefined {
  if (entry.actionId) return `${entry.toolName}:action:${entry.actionId}`;
  if (entry.taskId && entry.nodeId) return `${entry.toolName}:node:${entry.taskId}:${entry.nodeId}`;
  // A provider may reuse a tool-call id. Prefer the bank's durable execution identity when no
  // action/node identity is available, so two ledger writes cannot disappear into one narration.
  const data = entry.result.data;
  if (typeof data === 'object' && data !== null && 'transactionId' in data && typeof data.transactionId === 'string') {
    return `${entry.toolName}:transaction:${data.transactionId}`;
  }
  if (entry.toolCallId) return `${entry.toolName}:call:${entry.toolCallId}`;
  return undefined;
}
