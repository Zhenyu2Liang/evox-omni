import type { SessionSnapshot } from '@/agent/session';
import { readTranscriptActivity } from '@/agent/transcript-activity';
import { prisma } from '@/lib/db/client';
import { withActionPolicy } from '@/lib/action-summary';
import { safeParse } from '@/lib/json';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { AnomalyReport } from '@/banking-sdk';
import { MANUAL_CARD_COMMAND_NAMES } from '@/lib/contracts/card-management';
import { selectChatHistoryPage } from '@/lib/chat-history';
import { readConversationPlans } from './plan-history';
import { AppError } from '@/lib/errors';

/** The generation changes only when the developer starts a new conversation history. */
export function conversationHistoryGeneration(snapshot: SessionSnapshot): string {
  if (!snapshot.historyGeneration) throw new AppError('INTERNAL', 'Conversation history generation is unavailable.');
  return snapshot.historyGeneration;
}

/** Refresh business state before selecting a bounded page, without truncating stored archives. */
export async function readChatHistoryPage(snapshot: SessionSnapshot,
  options: { cursor?: string; limit?: number } = {}): Promise<ChatHistoryPage> {
  const [messages, rows, acknowledgements] = await Promise.all([
    readTranscriptActivity(snapshot).then(activity => readConversationPlans(snapshot, activity)),
    prisma.pendingAction.findMany({ where: { sessionId: snapshot.sessionId, userId: snapshot.userId,
      toolName: { notIn: [...MANUAL_CARD_COMMAND_NAMES] } } }),
    prisma.auditLog.findMany({ where: { userId: snapshot.userId, toolName: 'acknowledge_transaction' }, select: { detail: true } }),
  ]);
  const page = selectChatHistoryPage(messages, {
    sessionId: snapshot.sessionId, userId: snapshot.userId, revision: snapshot.revision,
    historyGeneration: conversationHistoryGeneration(snapshot),
  }, options);
  const decisions = new Map(rows.map(row => [row.id, row]));
  const acknowledged = new Set(acknowledgements.map(row => row.detail));
  return { ...page, messages: page.messages.map(message => ({ ...message,
    cards: (message.cards ?? []).map(card => {
      if (card.type === 'mfa' || (card.type === 'confirmation' && card.action.actionId)) {
        const id = card.type === 'mfa' ? card.actionId : card.action.actionId!;
        const row = decisions.get(id);
        if (!row) return card;
        const stored = safeParse<PendingActionSummary | undefined>(row.summaryJson, card.action);
        const action = stored && withActionPolicy(stored, { actionId: id, tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa });
        if (row.status === 'awaiting_mfa' && action) return { type: 'mfa' as const, actionId: id, action };
        if (card.type === 'mfa') return { ...card, action, status: row.status };
        return { ...card, action: { ...action!, status: row.status } };
      }
      if (card.type === 'anomaly') {
        const report = card.data as AnomalyReport;
        return { ...card, data: { ...report,
          anomalies: report.anomalies.map(item => ({ ...item, acknowledged: acknowledged.has(item.transaction.id) })) } };
      }
      return card;
    }),
  })) };
}
