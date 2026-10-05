# agent — AI Agent Chat Page (`/agent`)

## Intent

The **AI Agent chat screen**: the demo's centrepiece, where the user describes a financial
need in natural language and watches the agent loop 理解 → 规划 → 执行 → 风控 → 验证 → 审计
unfold (task steps, tool status, results, confirmation / MFA prompts).

This node is a **thin Server Component wrapper** — it owns no business logic and does no data
reads beyond a single cookie lookup. All chat data arrives client-side: the chat window streams
a turn from `POST /api/chat` (SSE `AgentStreamEvent`s) and drives confirmations through
`POST /api/actions/[id]/{confirm,verify,cancel}`.

## API Surface

- **Page route**: `/agent` — `page.tsx`, default-exported **async** Server Component.
- **Server read**: the `banking_session` cookie (`SESSION_COOKIE`), read via `cookies()` from
  `next/headers`. The cookie is `HttpOnly`, so only the server can read it; the page forwards its
  value to the client as the `sessionId` prop. This lets a page **REFRESH** recover the running
  session and fetch the current plan (`GET /api/tasks` / `GET /api/tasks/[id]`) instead of starting
  blank. When the cookie is absent the prop is `undefined` and the client creates a session on the
  first turn as before. Reading the cookie opts this route into **dynamic rendering** (the route
  shows as `ƒ` in `next build`).
- **Composes** (from `../components`, Client Component — API owned there, referenced by name only):
  `<ChatWindow sessionId={…} className="min-h-[60vh]" />` — input, message list, task timeline,
  cards (balance / transfer / confirm / MFA / anomaly / plan), confirmation & verification prompts.

## Constraints

- **Server Component** (no `'use client'`); render chrome/title only — no UI logic, no business
  reads beyond the session cookie.
- Pass only **serializable** props to client components — `sessionId` is a plain `string | undefined`.
- **Never build** the chat components here; reference them from `../components` (read-only sibling).
  Plan fetching/rendering lives in `../components`, not here.
- Never import Prisma / `banking-sdk` / `security` / `agent` / `planner` in this node.
- No LLM chain-of-thought in the UI — show task steps, tool status and results only.
- Keep the file ≲ ~120 lines.

## Dependencies

- `next/headers` — `cookies()` for the `HttpOnly` session cookie (server-only).
- `../components` (sibling — read-only): `ChatWindow` (accepts optional `sessionId`, `initialMessages`,
  `endpoints`, `className`) and the chat card primitives.
- `../lib/constants` (sibling — read-only): `SESSION_COOKIE` cookie name.
- `../lib/contracts` (sibling — read-only): `AgentStreamEvent`, `ChatTurnRequest` / `ChatTurnResponse`
  — the transport shapes chat consumes (via the API, not imported here).

## Routing Table

- `./page.tsx` → the `/agent` chat page (reads the session cookie, renders the client `ChatWindow`)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → API routes the client uses for streaming + actions + plan recovery (`chat`, `actions/[id]/*`, `tasks`) (sibling — read-only)
