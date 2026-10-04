# components/chat — Chat surface (messages, tool timeline, streaming)

## Intent

The interactive chat surface: the message list, the composer, the tool/task status timeline, the
streaming text, and the stateful `useAgentStream` hook that folds `AgentStreamEvent`s into UI state.
Plus the thin **client fetch helpers** the surface uses to drive `./app` action routes. All **Client
Components** (`'use client'`). It renders the card renderers from `./chat/cards` but does not define them.

## API Surface

Named exports, re-exported from `./index.ts`. Types from `@/lib/contracts/agent`.

```ts
// useAgentStream.ts — the stateful fold of AgentStreamEvent[] → chat UI state
/** MFA-prompt summary; `toolName` is the actual blocked tool the stream reported (never invented). */
export interface MfaActionSummary extends Omit<PendingActionSummary, 'toolName'> { toolName?: ToolName; }

/** The ACTIVE human decision (from a confirmation_required/mfa_required event); `kind` discriminates. */
export type PendingHumanDecision =
  | { kind: 'confirmation'; summary: PendingActionSummary; actionId: string }
  | { kind: 'mfa'; summary: MfaActionSummary; actionId: string; hint?: string };

export interface UseAgentStreamResult {
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: PendingHumanDecision;              // { kind, summary, actionId, hint? }
  streamingText: string;
  busy: boolean;
  error?: string;
  applyEvents(events: AgentStreamEvent[]): void;     // fold a batch (used by actions + SSE)
  send(text: string): Promise<void>;                 // POST /api/chat, fold response
  confirm(actionId: string): Promise<void>;          // POST /api/actions/:id/confirm
  verify(actionId: string, code: string): Promise<void>; // POST .../verify
  cancel(actionId: string): Promise<void>;           // POST .../cancel
}
export interface UseAgentStreamOptions { sessionId?: string; endpoints?: ChatEndpoints;
  initialMessages?: ChatMessage[]; taskId?: string; }   // taskId → refresh recovery on mount
export function useAgentStream(o?: UseAgentStreamOptions): UseAgentStreamResult; // 'use client'

// ChatWindow.tsx — the container: message list + live plan + active decision card; owns useAgentStream
export interface ChatWindowProps { sessionId?: string; initialMessages?: ChatMessage[];
  endpoints?: ChatEndpoints; taskId?: string; className?: string; }
export function ChatWindow(p: ChatWindowProps): JSX.Element;        // 'use client'

// MessageBubble.tsx — one message; renders text + any cards via CardRenderer + tool events
export interface MessageBubbleProps { message: ChatMessage; action?: CardActionHandlers; className?: string; }
export function MessageBubble(p: MessageBubbleProps): JSX.Element; // 'use client'

// Composer.tsx — textarea + send button; enter-to-send
export interface ComposerProps { onSend: (text: string) => void; disabled?: boolean;
  busy?: boolean; placeholder?: string; className?: string; }
export function Composer(p: ComposerProps): JSX.Element;           // 'use client'

// ToolEventList.tsx — task/tool status timeline (NO chain-of-thought)
export interface ToolEventListProps { events: ToolEventView[]; className?: string; }
export function ToolEventList(p: ToolEventListProps): JSX.Element; // 'use client'

// StreamingText.tsx — incremental assistant text with a caret while active
export interface StreamingTextProps { text: string; active?: boolean; className?: string; }
export function StreamingText(p: StreamingTextProps): JSX.Element; // 'use client'
```

```ts
// actions.ts — client-side fetch contract for the app's API routes
export interface ChatEndpoints {
  chat: string;                                // default '/api/chat'
  confirm: (actionId: string) => string;       // default `/api/actions/${id}/confirm`
  verify:  (actionId: string) => string;       // default `/api/actions/${id}/verify`
  cancel:  (actionId: string) => string;       // default `/api/actions/${id}/cancel`
  task:    (id: string) => string;             // default `/api/tasks/${id}` — read ONE persisted plan
}
export const DEFAULT_ENDPOINTS: ChatEndpoints;
export function sendChatTurn(req: ChatTurnRequest, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function confirmAction(actionId: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function verifyAction(actionId: string, code: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function cancelAction(actionId: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
// NEVER-throwing plan read (refresh recovery): resolves the plan, else undefined on
// non-ok / error-envelope / malformed body / exception. Never surfaces a raw error to the UI.
export function fetchTaskPlan(id: string, endpoints?: ChatEndpoints): Promise<TaskPlan | undefined>;
```

## Event → state fold (consumed by `useAgentStream` / `ChatWindow`)

The fold is implemented as a **separately-exported PURE reducer** `reduceAgentEvents(state, events):
ChatUIState` (plus `initialChatUIState()` and the `ChatUIState` type) so it is unit-testable with
`AgentStreamEvent[]` fixtures and **no DOM**. `useAgentStream` merely wraps it in `useState`.

| `AgentStreamEvent` | state effect |
| --- | --- |
| `session` | set `sessionId` (persist for later turns) |
| `message_start` | append the message (pending assistant/user turn) |
| `text_delta` | append `delta` to `streamingText` |
| `message_end` | finalise message content/cards; clear `streamingText` |
| `tool_start` / `tool_end` | upsert a `ToolEventView` (status started→success/error/blocked); a `blocked` entry also records its `toolName` |
| `card` | append `card` to the current assistant message's `cards` — **except a `plan` card**, which is promoted into `activePlan` (never an inline card); see "Plan dedupe" |
| `plan_update` | UPSERT `activePlan`: a newer snapshot for the same `plan.id` replaces the stored one; an older `updatedAt` for the same id never regresses the view; a different id replaces the slot (one live plan at a time) |
| `confirmation_required` | set `pendingAction` `{ kind: 'confirmation', summary: event.action, actionId: event.actionId }` |
| `mfa_required` | set `pendingAction` `{ kind: 'mfa', summary: mfaSummary(state, event.hint), actionId: event.actionId, hint: event.hint }`; the summary's `toolName` is the actual gated tool the stream reported as blocked, omitted when the stream carried none |
| `security_event` | append a `system` `ChatMessage` (content = `event.message`; `event.kind` is not surfaced) |
| `error` | set `error` (never throw to the UI) |
| `done` | clear `busy` |

The MFA summary's `hint` is carried on `pendingAction.hint` so `ChatWindow` can render it; `pull()`
keeps the settle rule — `pendingAction` is cleared after a NON-error turn (a domain `error` keeps the
decision visible so the user can retry).

### Plan dedupe (at most ONE plan view per plan id)

Plan cards and `plan_update` events both flow through `upsertPlan` into the single `activePlan` slot:

- A `card` of type `plan` is **promoted** into `activePlan` and is NOT appended as an inline message
  card (so `CardRenderer`'s `plan` branch is not the live path — `activePlan` is).
- `ChatWindow` renders that ONE live plan via `PlanCard`, so node statuses advance on `plan_update`.
- Consequence: a `card`/`plan_update` pair for the same plan id can never leave a duplicate or stale
  plan card behind — there is exactly one plan surface per plan id.

### Human-decision card (exactly ONE per active action)

`ChatWindow` renders the active decision from `stream.pendingAction`: `kind === 'confirmation'` →
`ConfirmationCard`, `kind === 'mfa'` → `MfaCard` (both reused from `./cards`, never forked). They share
the SAME `CardActionHandlers` bundle built in `ChatWindow`, so confirm/verify/cancel POST to the
`./app` routes — the browser never executes a banking op and no parallel confirm flow exists.

If the agent ALSO emits a matching inline `confirmation`/`mfa` `card`, `ChatWindow` suppresses that
duplicate (`withoutDuplicateDecisionCard`, matched by `actionId` for MFA and by the summary for
confirmation) so exactly one card is visible for the active action; a message left empty by the
removal is dropped (no empty bubble). Older/unrelated decision cards are preserved.

### Refresh recovery

`ChatWindow` takes an optional `taskId` threaded into `useAgentStream`. On mount the hook:

- fetches `taskId` when provided, otherwise the last-seen plan id persisted in `sessionStorage`
  (`banking-agent:activePlanId`, written whenever `activePlan` changes);
- never overwrites a plan a live `plan_update` already delivered, and ignores a stale/unmounted or
  failed fetch (an `alive` cleanup flag; `fetchTaskPlan` resolves `undefined` instead of throwing).

## Known Issues

- `applyEvent` has a `default: return state` branch (no `assertNever`) — a NEW `AgentStreamEvent` variant silently no-ops instead of failing compilation (contrast `CardRenderer`'s exhaustive guard).
- `security_event` drops `event.kind` and is rendered as a `system` message, not a banner.
- The `error` event only sets `state.error`; with no active pending card it is not rendered in `ChatWindow` (the pending cards surface it via `CardActionHandlers.error`).
- **Gated PLAN nodes get no actionable card.** A plan node's gated tool runs inside the executor's `runTool` (`agent/confirmation.ts` `executeGatedTool`), NOT through pi's `beforeToolCall`, so `submit_plan` succeeds (`agent/tools/planning.ts`) and no `confirmation_required`/`mfa_required` is emitted for a plan node — the live plan view shows a passive 待确认 badge with no confirm button.
- No UI entry point passes `taskId` yet: `app/agent/page.tsx` renders `<ChatWindow/>` without it, so refresh recovery currently relies on the `sessionStorage` fallback.

## Constraints

- **All Client Components** (`'use client'`) — hooks, streaming, fetch.
- **The browser never executes a banking op.** Confirm/verify/cancel POST to `./app` routes; the server
  re-validates and executes. `useAgentStream` only folds the returned `ChatTurnResponse.events`.
- **No chain-of-thought**: `ToolEventList`/`StreamingText`/`PlanCard` render only steps, tool status and
  factual results (tool names, tiers, `summary`), never raw model reasoning.
- **No MFA code** is displayed anywhere; `MfaCard` (in `./cards`) shows only the hint.
- No `prisma`; data via props + `fetch` to `./app`. Money/status visuals via `../../ui`.
- `actions.ts` helpers **never throw** — every failure (network / parse / non-OK / domain `ok:false`)
  folds into a safe `{ type: 'error', message }` `AgentStreamEvent` (or, for `fetchTaskPlan`,
  `undefined`), so the UI never sees a raw exception.
- Named exports only; files ≲ ~1000 lines, one concern per file.
- `ChatWindow` builds the `CardActionHandlers` bundle with `actionId`/`onConfirm`/`onVerify`/`onCancel`/`busy`/`error`
  **plus** the anomaly handlers `onAcknowledge`/`onViewDetail`/`onFreeze`. Those three are
  fire-and-forget `stream.send(...)` calls (「这笔交易是我本人消费」/「我想查看这笔交易的详情」/「冻结我的银行卡」),
  so every anomaly button flows chat → agent → Security Gateway as an ordinary user message — the browser
  never calls a banking op directly (the freeze button drives `freeze_card`, which the gateway routes YELLOW
  → user confirmation).

## Test Strategy

- `useAgentStream` is a **pure fold** over `AgentStreamEvent[]` → unit-test it with scripted event
  sequences (from the faux-provider scenarios) under the root `tests/` suite: card attachment,
  plan promotion/upsert (one plan view per id), tool-event upsert, confirmation/mfa transitions
  with `kind`, error→banner, done→idle.
- `ChatWindow` integration test: feed a scripted event list, assert rendered messages/cards/timeline,
  the single live plan and the single active decision card.
- `Composer`: enter-to-send + disabled-when-busy behaviour.

## Routing Table

- `./ChatWindow.tsx` → container: message list + live plan + active decision card + composer, owns `useAgentStream`
- `./MessageBubble.tsx` → one message (text + cards via `./cards/CardRenderer` + tool events)
- `./Composer.tsx` → input + send
- `./ToolEventList.tsx` → tool/task status timeline (no chain-of-thought)
- `./StreamingText.tsx` → incremental assistant text
- `./useAgentStream.ts` → the event→state hook (chat state machine) + refresh recovery
- `./actions.ts` → typed client fetch helpers + `ChatEndpoints`/`DEFAULT_ENDPOINTS`/`fetchTaskPlan`
- `./cards/` → the `ChatCard` renderers + `CardRenderer` dispatcher
- `./index.ts` → re-exports the chat surface + action helpers
- `../../ui/` → primitives used here (dependency — read-only)
