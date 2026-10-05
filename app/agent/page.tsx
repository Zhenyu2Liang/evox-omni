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

export default async function AgentPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value ?? undefined;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">AI Agent</h1>
        <p className="mt-1 text-sm text-banking-navy">
          用自然语言描述需求：Agent 会理解意图、规划任务，并在风控校验后调用银行工具。
        </p>
      </header>

      <ChatWindow sessionId={sessionId} className="min-h-[60vh]" />
    </main>
  );
}
