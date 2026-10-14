import type { PendingAction } from '@/lib/db/prisma';
import type { ChatCard, ChatMessage } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import type { RiskLevel } from '@/lib/contracts/risk';
import { isCatalogToolName } from '@/lib/contracts/tool-catalog';
import { safeParse } from '@/lib/json';
import { withActionPolicy } from '@/lib/action-summary';

export type PlanApprovalEvidence = Pick<PendingAction,
  'id' | 'taskId' | 'nodeId' | 'toolName' | 'riskLevel' | 'requiresMfa' | 'summaryJson' | 'status'>;

function actionIdentity(card: ChatCard): string | undefined {
  return card.type === 'mfa' ? card.actionId : card.type === 'confirmation' ? card.action.actionId : undefined;
}

/** Restore issued permissions from durable actions, even after node output becomes a receipt. */
export function projectPlanApprovals(messages: readonly ChatMessage[], plan: TaskPlan,
  actions: readonly PlanApprovalEvidence[]): ChatMessage[] {
  const owner = messages.find(message => message.cards?.some(card => card.type === 'plan' && card.plan.id === plan.id));
  if (!owner) return [...messages];
  const records: ChatCard[] = [];
  for (const row of actions) {
    if (row.taskId !== plan.id || !plan.nodes.some(node => node.id === row.nodeId && node.tool === row.toolName) ||
        !isCatalogToolName(row.toolName)) continue;
    const stored = safeParse<PendingActionSummary | undefined>(row.summaryJson, undefined);
    if (!stored || stored.toolName !== row.toolName || !Array.isArray(stored.fields)) continue;
    const action = withActionPolicy({ ...stored, status: row.status } as PendingActionSummary, {
      actionId: row.id, tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa,
    });
    records.push(action.requiresMfa || action.tier === 'RED'
      ? { type: 'mfa', actionId: row.id, action, status: row.status }
      : { type: 'confirmation', action });
  }
  const restoredIds = new Set(records.map(actionIdentity));
  return messages.map(message => ({ ...message,
    cards: [...(message.cards ?? []).filter(card => !restoredIds.has(actionIdentity(card))),
      ...(message.id === owner.id ? records : [])],
  }));
}
