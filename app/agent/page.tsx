/**
 * AI Agent chat — `/agent` (Server Component wrapper; no business logic).
 *
 * Data: the configured demo user's persisted conversation, latest plan and pending actions.
 * The client streams a turn from
 *   `POST /api/chat` (SSE `AgentStreamEvent`s) and drives confirmations through
 *   `POST /api/actions/[id]/{confirm,verify,cancel}`.
 *
 * Session recovery: `getDemoSession` creates or loads the fixed `demo:${userId}` workspace.
 * The server passes the newest 20 projected messages and an older-history cursor to `ChatWindow`.
 * All browsers share this demo workspace without login or an authentication cookie.
 *
 * Composes (`@/components`, Client Component — referenced by name only; the library owns the API):
 *   `<ChatWindow/>` — input, message list, task timeline, cards, confirmation / MFA prompts.
 */
import { ChatWindow } from '@/components';
import { getDemoSession } from '@/agent/session';
import { resolveUserId } from '@/app/api/_lib/session';
import { prisma } from '@/lib/db/client';
import { getServerI18n } from '@/lib/i18n/server';
import { readChatHistoryPage } from './history';
import { AssistantHelpButton } from '@/components/help/AssistantHelp';

// Reads live conversation state and language preference; render on demand instead of at build.
export const dynamic = 'force-dynamic';

export default async function AgentPage() {
  const { t } = await getServerI18n();
  const snapshot = await getDemoSession(resolveUserId());
  const sessionId = snapshot.sessionId;
  const latestTask = await prisma.agentTask.findFirst({ where: { sessionId: snapshot.sessionId, userId: snapshot.userId,
    status: { in: ['pending', 'running', 'paused', 'waiting_confirmation', 'failed'] },
    ...(snapshot.historyStartedAt ? { createdAt: { gte: new Date(snapshot.historyStartedAt) } } : {}) },
    orderBy: { createdAt: 'desc' }, select: { id: true } });
  const initialHistory = await readChatHistoryPage(snapshot);

  return (
    <main data-demo-session-id={sessionId} className="assistant-workspace flex min-h-0 flex-col">
      <header data-chat-page-header className="hidden shrink-0 items-center justify-between gap-4 border-b border-banking-border/70 bg-white/80 px-5 py-4 sm:px-8 lg:flex">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-banking-deep">{t('app.assistant')}</h1>
          <p className="mt-1 text-xs text-banking-navy">{t('app.slogan')}</p>
        </div>
        <AssistantHelpButton />
      </header>

      <ChatWindow key={initialHistory.historyGeneration} sessionId={sessionId} taskId={latestTask?.id} initialHistory={initialHistory} className="flex-1" />
    </main>
  );
}
