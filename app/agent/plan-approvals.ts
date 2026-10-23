import type { PendingAction } from '@/lib/db/prisma';
import type { ChatCard, ChatMessage } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import { isCatalogToolName } from '@/lib/contracts/tool-catalog';
import { approvalCard, decisionSummary, verificationCard } from './decision-record';

export type PlanApprovalEvidence = Pick<PendingAction,
  'id' | 'taskId' | 'nodeId' | 'toolName' | 'riskLevel' | 'requiresMfa' | 'summaryJson' | 'status'>;

function actionIdentity(card: ChatCard): string | undefined {
  return card.type === 'mfa' ? card.actionId : card.type === 'confirmation' ? card.action.actionId : undefined;
}

/**
 * Restore issued permissions from durable actions, even after node output becomes a receipt.
 *
 * Every restored card is a RECORD carrying the persisted status (see `decision-record.ts`): a
 * `locked` / `executed` / `failed` / `cancelled` action is projected as settled history, so no
 * plan projection can ever re-open a verification that the server already terminated. The
 * interactive panel is rebuilt only from a row that is still `pending`/`awaiting_mfa`, and only by
 * the client's decision dock.
 */
export function projectPlanApprovals(messages: readonly ChatMessage[], plan: TaskPlan,
  actions: readonly PlanApprovalEvidence[]): ChatMessage[] {
  const owner = messages.find(message => message.cards?.some(card => card.type === 'plan' && card.plan.id === plan.id));
  if (!owner) return [...messages];
  const records: ChatCard[] = [];
  for (const row of actions) {
    if (row.taskId !== plan.id || !plan.nodes.some(node => node.id === row.nodeId && node.tool === row.toolName) ||
        !isCatalogToolName(row.toolName)) continue;
    const summary = decisionSummary(row);
    // The stored summary must describe THIS tool; a mismatched row carries no evidence for this node.
    if (!summary || summary.toolName !== row.toolName) continue;
    records.push(summary.requiresMfa || summary.tier === 'RED'
      ? verificationCard(row, summary)
      : approvalCard(row, summary));
  }
  const restoredIds = new Set(records.map(actionIdentity));
  return messages.map(message => ({ ...message,
    cards: [...(message.cards ?? []).filter(card => !restoredIds.has(actionIdentity(card))),
      ...(message.id === owner.id ? records : [])],
  }));
}
