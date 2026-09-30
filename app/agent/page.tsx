/**
 * AI Agent chat — `/agent` (Server Component wrapper; no server reads at render).
 *
 * Data: none here — the client streams a turn from `POST /api/chat` (SSE `AgentStreamEvent`s)
 *   and drives confirmations through `POST /api/actions/[id]/{confirm,verify,cancel}`.
 *
 * Composes (`../components`, Client Component — referenced by name only; the library owns the API):
 *   `<ChatWindow/>` — input, message list, task timeline, cards, confirmation / MFA prompts.
 */
export default function AgentPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">AI Agent</h1>
        <p className="mt-1 text-sm text-banking-navy">
          用自然语言描述需求：Agent 会理解意图、规划任务，并在风控校验后调用银行工具。
        </p>
      </header>

      {/*
        TODO: render the client chat window from `@/components` — do NOT build it here:
          <ChatWindow sessionId={...} />
      */}
      <section className="rounded-2xl bg-white p-6 text-sm text-banking-navy shadow-sm">
        对话窗口（输入、消息列表、任务时间线、卡片、确认 / 验证码提示）将由 `@/components` 渲染。
      </section>
    </main>
  );
}
