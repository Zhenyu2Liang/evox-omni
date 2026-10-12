/**
 * AI Agent chat — `/agent` (Server Component wrapper; no business logic).
 *
 * Data: none read here beyond the session cookie — the client streams a turn from
 *   `POST /api/chat` (SSE `AgentStreamEvent`s) and drives confirmations through
 *   `POST /api/actions/[id]/{confirm,verify,cancel}`.
 *
 * Session recovery: the demo session id lives in the HttpOnly `banking_session` cookie
 *   (`SESSION_COOKIE`), which only the SERVER can read. We read it here and hand it to the
 *   client `ChatWindow` so a page REFRESH can recover the running session and fetch the
 *   current plan (`GET /api/tasks`). Reading the cookie opts this route into dynamic rendering.
 *
 * Composes (`@/components`, Client Component — referenced by name only; the library owns the API):
 *   `<ChatWindow/>` — input, message list, task timeline, cards, confirmation / MFA prompts.
 */
import { cookies } from 'next/headers';
import { ChatWindow } from '@/components';
import { SESSION_COOKIE } from '@/lib/constants';
import { loadSession } from '@/agent/session';
import { prisma } from '@/lib/db/client';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { AnomalyReport } from '@/banking-sdk';
import { withActionPolicy } from '@/lib/action-summary';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { RiskLevel } from '@/lib/contracts/risk';
import { safeParse } from '@/lib/json';

// Reads the request cookie, so it must render per request — never statically prerendered at build.
export const dynamic = 'force-dynamic';

export default async function AgentPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value ?? undefined;
  const snapshot = sessionId ? await loadSession(sessionId) : null;
  const latestTask = snapshot ? await prisma.agentTask.findFirst({ where: { sessionId: snapshot.sessionId, userId: snapshot.userId }, orderBy: { createdAt: 'desc' }, select: { id: true } }) : null;
  const rows = snapshot ? await prisma.pendingAction.findMany({ where: { sessionId: snapshot.sessionId, userId: snapshot.userId } }) : [];
  const decisions = new Map(rows.map(row => [row.id, row]));
  const ackRows = snapshot ? await prisma.auditLog.findMany({ where: { userId: snapshot.userId, toolName: 'acknowledge_transaction' }, select: { detail: true } }) : [];
  const acknowledgements = new Set(ackRows.map(row => row.detail));
  const initialMessages: ChatMessage[] = (snapshot?.transcript ?? []).map(message => ({ ...message,
    cards: (message.cards ?? []).filter(card => card.type !== 'plan').map(card => {
      if (card.type === 'mfa' || (card.type === 'confirmation' && card.action.actionId)) {
        const id = card.type === 'mfa' ? card.actionId : card.action.actionId!;
        const row = decisions.get(id);
        if (!row) return card;
        const fallback = card.action;
        const stored = safeParse<PendingActionSummary | undefined>(row.summaryJson, fallback);
        const action = stored && withActionPolicy(stored, { actionId: id, tier: row.riskLevel as RiskLevel, requiresMfa: row.requiresMfa });
        if (row.status === 'awaiting_mfa' && action) return { type: 'mfa' as const, actionId: id, action };
        if (card.type === 'mfa') return { ...card, action, status: row.status };
        return { ...card, action: { ...action!, status: row.status } };
      }
      if (card.type === 'anomaly') {
        const report = card.data as AnomalyReport;
        return { ...card, data: { ...report, anomalies: report.anomalies.map(item => ({ ...item, acknowledged: acknowledgements.has(item.transaction.id) })) } };
      }
      return card;
    }),
  }));

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">AI Agent</h1>
        <p className="mt-1 text-sm text-banking-navy">
          用自然语言描述需求：Agent 会理解意图、规划任务，并在风控校验后调用银行工具。
        </p>
      </header>

      <ChatWindow sessionId={sessionId} taskId={latestTask?.id} initialMessages={initialMessages} className="min-h-[60vh]" />
    </main>
  );
}
