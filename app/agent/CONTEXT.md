# agent — AI Agent Chat Page (`/agent`)

## Intent

The **AI Agent chat screen**: the demo's centrepiece, where the user describes a financial
need in natural language and watches the agent loop 理解 → 规划 → 执行 → 风控 → 验证 → 审计
unfold (task steps, tool status, results, confirmation / MFA prompts).

This node is a **thin Server Component wrapper** — it owns no banking business logic. It loads the
configured demo workspace, persisted transcript, authoritative plan history and pending actions. The chat streams
new turns from `POST /api/chat` (SSE `AgentStreamEvent`s) and drives confirmations through
`POST /api/actions/[id]/{confirm,verify,cancel}`.

## API Surface

- **Page route**: `/agent` — `page.tsx`, default-exported **async** Server Component.
- **Plan history**: `plan-history.ts` restores persisted task/node outcomes inside the current
  conversation history boundary. It associates each plan with its original `submit_plan` run and
  call; the first message ownership event wins even when an authorization run republishes that
  message. A crash-orphaned plan becomes a chronological historical record, never a footer attached
  to an unrelated later reply. Completed/cancelled plans are kept in history; only actionable task
  statuses can be selected for client `taskId` recovery.
- **Server identity**: `getDemoSession(resolveUserId())` creates or loads the fixed `demo:${userId}`
  workspace from trusted configuration. The page passes its identity and restored presentation
  state to the client on every opening. All browsers share the workspace without login or an
  authentication cookie. Language preference is separate. The page is explicitly dynamic so
  persisted conversation and decision state are read on demand, not during a production build.
- **Composes** (from `../components`, Client Component — API owned there, referenced by name only):
  `<ChatWindow sessionId={…} initialMessages={…} taskId={…} className={…} />` — input, message list, task timeline,
  cards (balance / transfer / confirm / MFA / anomaly / plan), confirmation & verification prompts.

## Constraints

- **Server Component** (no `'use client'`); restore presentation state and render localized chrome,
  with no banking mutations or authorization decisions.
- Pass only **serializable** props to client components; the fixed session ID is a plain string.
- **Never build** the chat components here; reference them from `../components` (read-only sibling).
  Client plan refresh/rendering lives in `../components`; the page restores the initial snapshot.
- Server-only session/repository reads may restore state; client components must not import them.
- No LLM chain-of-thought in the UI — show task steps, tool status and results only.
- Keep the file ≲ ~120 lines.

## Dependencies

- `@/agent/session` and `@/app/api/_lib/session` — canonical demo workspace and configured user.
- `@/lib/db/client` — read-only restoration of current plan and pending action presentation.
- `@/lib/chat-plan-history` — pure placement of one plan card into its owning historical message.
- `@/app/api/_lib/task-plans` — shared mapping of persisted node rows to transport snapshots.
- `@/lib/i18n/server` — server localization using the language preference cookie.
- `../components` (sibling — read-only): `ChatWindow` (accepts optional `sessionId`, `initialMessages`,
  `taskId`, `endpoints`, `className`) and the chat card primitives.
- `../lib/contracts` (sibling — read-only): `AgentStreamEvent`, `ChatTurnRequest` / `ChatTurnResponse`
  — the transport shapes chat consumes (via the API, not imported here).

## Routing Table

- `./page.tsx` → the `/agent` chat page (restores the fixed demo workspace and renders `ChatWindow`)
- `./plan-history.ts` → read-only restoration of task results and exact historical plan ownership
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → API routes the client uses for streaming + actions + plan recovery (`chat`, `actions/[id]/*`, `tasks`) (sibling — read-only)
