# agent — AI Agent Chat Page (`/agent`)

## Intent

The **AI Agent chat screen**: the demo's centrepiece, where the user describes a financial
need in natural language and watches the agent loop 理解 → 规划 → 执行 → 风控 → 验证 → 审计
unfold (task steps, tool status, results, confirmation / MFA prompts).

This node is a **thin Server Component wrapper only** — it performs **no server reads**. All
data arrives client-side: the chat window streams a turn from `POST /api/chat` (SSE
`AgentStreamEvent`s) and drives confirmations through `POST /api/actions/[id]/{confirm,verify,cancel}`.

## API Surface

- **Page route**: `/agent` — `page.tsx`, default-exported Server Component.
- **Read model(s)**: none at render (client streams from the API).
- **Composes** (from `../components`, Client Component — API owned there, referenced by name only):
  `<ChatWindow/>` — input, message list, task timeline, cards (balance / transfer / confirm / MFA /
  anomaly / plan), confirmation & verification prompts.

## Constraints

- **Server Component** (no `'use client'`); render chrome/title only — no UI logic, no server reads.
- Pass only **serializable** props to client components (no `Date` — epoch ms).
- **Never build** the chat components here; reference them from `../components` (read-only sibling).
- Never import Prisma / `banking-sdk` / `security` / `agent` / `planner` in this node.
- No LLM chain-of-thought in the UI — show task steps, tool status and results only.
- Keep the file ≲ ~120 lines.

## Dependencies

- `../components` (sibling — read-only): `ChatWindow` and the chat card primitives.
- `../lib/contracts` (sibling — read-only): `AgentStreamEvent`, `ChatTurnRequest` / `ChatTurnResponse`
  — the transport shapes chat consumes (via the API, not imported here).

## Routing Table

- `./page.tsx` → the `/agent` chat page (renders the client `ChatWindow`)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → API routes the client uses for streaming + actions (`chat`, `actions/[id]/*`) (sibling — read-only)
