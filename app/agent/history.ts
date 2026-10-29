import type { SessionSnapshot } from '@/agent/session';
import { readTranscriptActivity } from '@/agent/transcript-activity';
import { prisma } from '@/lib/db/client';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import type { ChatCard } from '@/lib/contracts/agent';
import type { AnomalyReport } from '@/banking-sdk';
import { MANUAL_CARD_COMMAND_NAMES } from '@/lib/contracts/card-management';
import { selectChatHistoryPage } from '@/lib/chat-history';
import { readConversationPlans } from './plan-history';
import { approvalCard, decisionSummary, verificationCard, type DecisionRow } from './decision-record';
import { AppError } from '@/lib/errors';
import { projectScheduledSummary } from '@/security/scheduled-summary';

/** The generation changes only when the developer starts a new conversation history. */
export function conversationHistoryGeneration(snapshot: SessionSnapshot): string {
  if (!snapshot.historyGeneration) throw new AppError('INTERNAL', 'Conversation history generation is unavailable.');
  return snapshot.historyGeneration;
}

/** The persisted action a card displays, keyed by the action id the card already carries. */
function cardActionId(card: ChatCard): string | undefined {
  if (card.type === 'mfa') return card.actionId;
  if (card.type === 'confirmation') return card.action.actionId;
  return undefined;
}

/**
 * Re-project ONE stored card from its persisted action row. The row is authoritative for the state
 * (see `decision-record.ts`); the stored card only supplies the shape and any hint/reason text.
 * A card whose row is missing or unrenderable is returned untouched — missing evidence is never
 * turned into a status of its own, a successful one above all.
 */
function projectCard(card: ChatCard, decisions: Map<string, DecisionRow>): ChatCard {
  const id = cardActionId(card);
  if (id === undefined) return card;
  const row = decisions.get(id);
  if (!row) return card;
  const fallback = card.type === 'confirmation' || card.type === 'mfa' ? card.action : undefined;
  const summary = decisionSummary(row, fallback);
  if (!summary) return card;
  if (card.type === 'mfa') return verificationCard(row, summary, { hint: card.hint, message: card.message });
  return approvalCard(row, summary);
}

/** Store the current acknowledgement state of every scanned anomaly on the stored card. */
function withAcknowledgements(card: Extract<ChatCard, { type: 'anomaly' }>, acknowledged: ReadonlySet<string | null>): ChatCard {
  const report = card.data as AnomalyReport;
  return { ...card, data: { ...report,
    anomalies: report.anomalies.map(item => ({ ...item, acknowledged: acknowledged.has(item.transaction.id) })) } };
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
  const decisions = new Map<string, DecisionRow>(await Promise.all(rows.map(async row => {
    const summary = decisionSummary(row);
    const projected = summary ? await projectScheduledSummary(snapshot.userId, summary) : undefined;
    return [row.id, projected && projected !== summary ? { ...row, summaryJson: JSON.stringify(projected) } : row] as const;
  })));
  const acknowledged = new Set(acknowledgements.map(row => row.detail));
  return { ...page, messages: page.messages.map(message => ({ ...message,
    cards: (message.cards ?? []).map(card =>
      card.type === 'anomaly' ? withAcknowledgements(card, acknowledged) : projectCard(card, decisions)),
  })) };
}
