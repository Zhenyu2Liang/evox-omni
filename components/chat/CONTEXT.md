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

/** A restored TERMINAL action a human must reconcile out-of-band (no server action, never re-invoked). */
export interface PendingReconciliation { summary: PendingActionSummary; actionId: string; }

export interface UseAgentStreamResult {
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: PendingHumanDecision;              // { kind, summary, actionId, hint? }
  pendingReconciliations: PendingReconciliation[];   // restored TERMINAL needs_reconciliation actions (display-only)
  streamingText: string;
  busy: boolean;
  restoring: boolean;                                // true while the mount-time pending-actions read is in flight
  mfaAttempts: number;                               // failed MFA attempts for the ACTIVE decision (0 when none)
  error?: string;
  applyEvents(events: AgentStreamEvent[]): void;     // fold a batch (used by actions + SSE)
  send(text: string): Promise<void>;                 // POST /api/chat, fold response
  confirm(actionId: string): Promise<void>;          // POST /api/actions/:id/confirm
  verify(actionId: string, code: string): Promise<void>; // POST .../verify
  cancel(actionId: string): Promise<void>;           // POST .../cancel
  controlTask(action: TaskControlAction, planId?: string): Promise<void>; // POST /api/tasks/:id { action }
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
  task:    (id: string) => string;             // default `/api/tasks/${id}` — read/control ONE persisted plan
  actions: string;                             // default '/api/actions' — list non-terminal pending actions
}
export const DEFAULT_ENDPOINTS: ChatEndpoints;
export function sendChatTurn(req: ChatTurnRequest, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function confirmAction(actionId: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function verifyAction(actionId: string, code: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function cancelAction(actionId: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
// NEVER-throwing plan read (refresh recovery): resolves the plan, else undefined on
// non-ok / error-envelope / malformed body / exception. Never surfaces a raw error to the UI.
export function fetchTaskPlan(id: string, endpoints?: ChatEndpoints): Promise<TaskPlan | undefined>;
// POST the SAME `task(id)` URL with `{ action }`; resolves the post-control snapshot, else undefined.
export function controlTask(id: string, action: TaskControlAction, endpoints?: ChatEndpoints): Promise<TaskPlan | undefined>;
// GET `actions`; tolerant of a top-level array OR `{ actions: [...] }`; keeps actionable
// (pending | awaiting_mfa) rows AND TERMINAL needs_reconciliation rows (the latter has no server
// action but must be SHOWN for out-of-band reconciliation, never re-invoked). Best-effort —
// resolves `[]` on ANY failure (never throws).
export interface PendingActionRef { id: string; status: PendingActionStatus; tier: RiskLevel;
  requiresMfa: boolean; summary: PendingActionSummary; }
export function fetchPendingActions(endpoints?: ChatEndpoints): Promise<PendingActionRef[]>;
export type { TaskControlAction };   // re-exported from the chat barrel (`./index.ts`)
```

`postAction` (the confirm/verify/cancel path) maps the `ActionResponse` to events defensively: an
**escalation / MFA-prompt** outcome (`requiresMfa && tier === 'RED' && !executed`, not a failed code)
gets an `mfa_required` `AgentStreamEvent` ensured (synthesised when the server omitted one) and is
**not** turned into a spurious `error`; any other `ok:false` outcome gets an `error` event appended
when the server sent none (e.g. a wrong MFA code arrives as `ok:false` + `status:'awaiting_mfa'` +
`mfaResult:'failed'` with an EMPTY event list).

## Event → state fold (consumed by `useAgentStream` / `ChatWindow`)

The fold is implemented as a **separately-exported PURE reducer** `reduceAgentEvents(state, events):
ChatUIState` (plus `initialChatUIState()` and the `ChatUIState` type) so it is unit-testable with
`AgentStreamEvent[]` fixtures and **no DOM**. `useAgentStream` merely wraps it in `useState`.
`pendingReconciliations` is NOT event-driven — it is seeded only by the refresh-restore effect (below).

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

Separately, `ChatWindow` renders one ACTIONLESS `ReconciliationCard` per restored terminal
`needs_reconciliation` action (from `pendingReconciliations`) — an amber warning with NO 确认/取消 and
NO code input, so a possibly-executed-but-unrecorded op is never re-invoked and is never mistaken for
a live 🟡/🔴 decision.

### Refresh recovery

`ChatWindow` takes an optional `taskId` threaded into `useAgentStream`. On mount the hook:

- fetches `taskId` when provided, otherwise the last-seen plan id persisted in `sessionStorage`
  (`banking-agent:activePlanId`, written whenever `activePlan` changes);
- never overwrites a plan a live `plan_update` already delivered, and ignores a stale/unmounted or
  failed fetch (an `alive` cleanup flag; `fetchTaskPlan` resolves `undefined` instead of throwing).

**Pending-action + reconciliation refresh restore.** A second one-shot mount effect ALWAYS runs
`fetchPendingActions()` (a terminal `needs_reconciliation` row carries no live decision of its own,
so it must be read even when a decision is already showing), then rebuilds two independent things:
- the ACTIVE human decision in the single `pendingAction` slot (so a reloaded page still shows the
  confirm/MFA card for an in-flight action) — the MOST RELEVANT actionable row wins:
  `requiresMfa || status === 'awaiting_mfa' || tier === 'RED'` → the `mfa` kind, else the
  `confirmation` kind;
- `pendingReconciliations` — every TERMINAL `needs_reconciliation` row, as a display-only list
  (no server action, never re-invoked), which `ChatWindow` renders one `ReconciliationCard` per row.

`restoring` is `true` while that read is in flight. Same guards as the plan recovery: an `alive`
cleanup flag, a functional `setState` that refuses to clobber a non-undefined `pendingAction` (or a
non-empty `pendingReconciliations`) already delivered by a live event, and a best-effort `[]` on
failure — it NEVER throws to the UI.

### Plan control (pause / resume / cancel / retry)

`useAgentStream.controlTask(action, planId?)` (defaulting `planId` to `state.activePlan?.id`) POSTs
`endpoints.task(id)` with `{ action }` via `controlTask` and folds the returned post-control snapshot
into the SAME `activePlan` slot (reusing the latest-wins `upsertPlan`). It sets `busy` around the call
and, on failure (`undefined`), surfaces a SAFE `error`; never throws. `ChatWindow` exposes it through
`CardActionHandlers.onTaskControl`, which `./cards/PlanCard` calls for its pause/resume/cancel/retry
buttons.

### MFA attempt counter

`ChatUIState.mfaAttempts` counts CONSECUTIVE failed verifications for the ACTIVE decision. `verify()`
increments it (post-`pull`, functional `setState`) only when the turn ends with an `mfa` `pendingAction`
still active AND an `error` set (a wrong code). An effect keyed on `pendingAction.actionId` + `kind`
resets it to `0` whenever the decision settles/clears or is replaced (success, cancel, or a new turn).
`ChatWindow` threads it into `MfaCard.attempts` via `CardActionHandlers.mfaAttempts`.

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
  folds into a safe `{ type: 'error', message }` `AgentStreamEvent`; the best-effort reads
  (`fetchTaskPlan`, `controlTask`, `fetchPendingActions`) instead resolve to `undefined` / `[]`,
  so the UI never sees a raw exception.
- Named exports only; files ≲ ~1000 lines, one concern per file.
- `ChatWindow` builds the `CardActionHandlers` bundle with `actionId`/`onConfirm`/`onVerify`/`onCancel`
  /`onTaskControl`/`mfaAttempts`/`busy`/`error` **plus** the anomaly handlers
  `onAcknowledge`/`onViewDetail`/`onFreeze`. `onTaskControl` is `stream.controlTask`; the anomaly three are
  fire-and-forget `stream.send(...)` calls (「这笔交易是我本人消费」/「我想查看这笔交易的详情」/「冻结我的银行卡」),
  so every anomaly button flows chat → agent → Security Gateway as an ordinary user message — the browser
  never calls a banking op directly (the freeze button drives `freeze_card`, which the gateway routes YELLOW
  → user confirmation).
- `ChatWindow` renders the live plan with control wiring (`<PlanCard plan={stream.activePlan}
  onControl={action.onTaskControl} busy={stream.busy} />`) and, while `stream.restoring` with nothing
  else to show, a `Spinner` + loading label **instead of** the empty state.

## Test Strategy

- `useAgentStream` is a **pure fold** over `AgentStreamEvent[]` → unit-test it with scripted event
  sequences (from the faux-provider scenarios) under the root `tests/` suite: card attachment,
  plan promotion/upsert (one plan view per id), tool-event upsert, confirmation/mfa transitions
  with `kind`, error→banner, done→idle.
- **No component/DOM test layer exists** — `@testing-library/react`/`jsdom`/`happy-dom` are NOT dependencies and `vitest.config.ts` runs `environment: 'node'`.
  the single live plan and the single active decision card.
- Refresh restore: a `fetchPendingActions` fixture carrying actionable AND `needs_reconciliation` rows
  must rebuild the decision slot AND the `pendingReconciliations` list (an actionless
  `ReconciliationCard` per reconciliation row) without clobbering a live decision.
- `Composer`: enter-to-send + disabled-when-busy behaviour.

## Routing Table

- `./ChatWindow.tsx` → container: message list + live plan + active decision card + composer, owns `useAgentStream`
- `./MessageBubble.tsx` → one message (text + cards via `./cards/CardRenderer` + tool events)
- `./Composer.tsx` → input + send
- `./ToolEventList.tsx` → tool/task status timeline (no chain-of-thought)
- `./StreamingText.tsx` → incremental assistant text
- `./useAgentStream.ts` → the event→state hook (chat state machine) + refresh recovery (plan, pending action AND reconciliation) + plan control + MFA attempt counter
- `./actions.ts` → typed client fetch helpers + `ChatEndpoints`/`DEFAULT_ENDPOINTS`/`fetchTaskPlan`/`controlTask`/`fetchPendingActions`
- `./cards/` → the `ChatCard` renderers + `CardRenderer` dispatcher + the non-union `ReconciliationCard`
- `./index.ts` → re-exports the chat surface + action helpers
- `../../ui/` → primitives used here (dependency — read-only)
