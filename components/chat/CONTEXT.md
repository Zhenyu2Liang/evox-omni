# components/chat — Chat surface (messages, tool timeline, streaming)

## Intent

Normal tool activity uses localized business labels and recorded status. Developer mode adds an
optional diagnostic fold with raw call names/identities and sanitized recorded arguments; disabling
the preference removes diagnostic DOM. `lib/tool-diagnostics.ts` removes credentials, reasoning,
full phone numbers and oversized nested data before event publication and again before display.
Completed authorized results also produce typed business cards, including checkpoint continuation
and page-opening projection. `cards/ResultCard.tsx` owns compact read-result framing; public results
never arise from model prose or submitted arguments. See `docs/cn/chat-presentation.md` for the mapping.

Static chat chrome and card controls use `useI18n()` with the shared product locale, which defaults
to `zh-CN`. English and Chinese templates live in `lib/i18n/messages/chat.{en,zh-CN}.json`.
Suggestion drafts and generated freeze requests use complete localized templates. A locale change
does not send a chat turn or replace historical messages, authoritative summaries, user input or IDs.
`lib/i18n/display.ts` translates only exact known transport messages and static authorization
metadata at render. Field values translate only closed policy fields; financial values, names and
unknown text pass through. `isActionAmountField` recognizes both current amount labels to avoid
displaying the same authorized amount twice.

The transcript uses a 72rem workspace with left-aligned assistant bubbles capped at 52rem and
right-aligned user bubbles capped at 40rem. Identity labels and avatars distinguish speakers.
Tool records align with the assistant side without sharing its prose bubble.
The assistant is the default application entry. ChatWelcome suggestions fill a draft without
submitting it. The viewport keeps the composer visible while conversation content scrolls.
Assistant text uses `AssistantMarkdown` with GFM tables, lists and code blocks. User text stays
literal. Raw HTML and image fetching are disabled; links accept only relative paths and the
HTTP, HTTPS and mailto schemes, with isolated new browsing contexts. Financial strings remain
unparsed text. Both streamed and persisted assistant text use this renderer; the stable
`data-assistant-content` attribute identifies complete assistant content for acceptance tests.
The live server withholds candidate prose until response checks finish; text_delta currently carries
the complete validated reply rather than individual provider tokens. Tools and plans can still
publish progress independently. reply_progress reports only generating, checking or repairing,
rendered as a localized status while no public reply text is available. It never exposes candidate
prose or corrective instructions, and request completion clears the phase.
`ToolEventList` groups recorded calls into query, payment, card, investment and workflow cards.
Each actual call owns an independent chronological role:tool message with empty content, exactly
one toolEvent stamped with its own messageId, and only that call's business cards. The later
assistant message contains prose only. Tool/card/plan events carry an explicit owner; the reducer
never guesses from the latest assistant or a reused provider call ID. Tool starts and ends do not
change the active prose owner. Results appear as soon as the server publishes them, before later
analysis; terminal snapshots update the original row in place. No live tool panel is duplicated
above the composer. Localized business names and statuses are public, while sanitized technical
details remain developer-only. History uses the same ordered rows and stable IDs after refresh.
Model-facing preflight corrections use a catalog-owned public summary and separate `debugDetail`.
Ordinary tool failures and unstarted operations never display unknown internal summary strings.
Tool and error-card diagnostics are available only in developer details and remain redacted.
`ResultCard` accepts business-projected children; do not feed compiler errors or model instructions
into its title or description. All refusal evidence remains recorded for recovery and inspection.
Auto-follow stops when the reader scrolls upward and
never skips the top of the empty welcome. Composer preserves IME candidate confirmation and uses
Shift+Enter for a newline. The composer is disabled while pending-action restoration is running.
Transport admission IDs use native randomUUID or a secure getRandomValues UUID v4 fallback for
ordinary HTTP pages; no random source means no new request. These IDs never authorize banking work.
Unexpected browser errors use a generic message; business errors come from the checked API envelope.
`transport-validation.ts` checks every SSE/JSON event and nested renderer payload before folding.
Malformed content objects, card data, tool status and task snapshots become a safe format error;
the browser never interprets model-authored JSON prose as a business result or truncates a reply.
The SSE decoder validates UTF-8 and flushes at EOF; LF, CRLF and CR boundaries remain correct across
byte chunks. A premature done with an open assistant or tool row reports an incomplete stream. Message starts
reset only a new owner's preview; duplicate or historical starts cannot erase completed messages.
Deltas without an active owner are ignored, and message_end remains authoritative for the full
reply, including changes made by server checks. Unscoped deltas cannot identify a previous owner
if the transport violates event ordering while a different message is active.
Plan error text uses the registered public-error projection; raw failures appear only in redacted
developer details. Locked actions settle both live and historical verification surfaces.
All chat/action/task requests share a synchronous admission lock. Their responses and queued state
updates check the request revision and conversation generation; late restoration reads cannot
reopen a settled action or insert a previous conversation's plan after clearing history.
When an SSE connection ends before done, the hook performs one latest-twenty history GET with a
five-second timeout. It restores complete saved assistant and tool rows by their original identity and
settles recorded terminal cards, retaining loaded older pages and optimistic user text. It never
reposts a financial request or fabricates a final message from partial stream text. A network-state
notice remains visible so the user can refresh and inspect operation history before resubmitting.
Mount-time plan and pending-action restoration use the server-provided fixed demo session identity.
Opening the assistant restores the same workspace and conversation across browsers without login.
Cookies and request identifiers cannot select another workspace; language cookies are preferences.

The server passes `initialHistory: ChatHistoryPage`, containing the latest twenty complete messages.
`history.ts` merges read-only older pages by ID with loaded and streamed messages taking precedence;
it also captures the first visible message offset to restore the reading position after prepending.
`history-request.ts` requests twenty rows from `/api/chat/history` with an opaque cursor, never owner
parameters. Failed reads keep all existing content and offer an explicit retry. The hook rejects
responses from a different history generation, aborts superseded reads and preserves loaded pages
across locale/developer preference refreshes. Refreshing the page opens the latest twenty again.
Pagination only affects presentation. It never cuts one reply or changes model context, original
archive retention, pending authorization restoration or independently tracked workflow controls.
Readers away from the bottom can return to the latest reply; new content never forces that jump.

The newest server reply may carry retryRequest when planning has not attempted a side effect.
ChatWindow offers one “重试规划” action; new user messages retire old buttons, and pending human
decisions/reconciliations suppress it. useAgentStream protects send with a synchronous ref so fast
repeated clicks do not start concurrent requests. This never retries confirm/verify automatically.

MFA escalation replaces the matching inline decision by action ID and retains the full server
summary. Settling one action preserves a different pending decision. Refresh summaries and risk
fields follow current authorization via `lib/action-summary.ts`; terminal cards remain terminal.

`actions.ts#postAction` synthesises MFA only for explicit pending/awaiting_mfa decisions. A
historical RED/requiresMfa flag on confirmed or terminal outcomes does not reopen that action's
verification card. Stale same-action MFA events are removed; a different next-plan action's event
is preserved. Domain failures, including needs_reconciliation, remain visible error events.
For a TERMINAL (settled) server status it emits the additive `action_settled` signal so a settled
decision card stops looking actionable on BOTH the live and inline surfaces.
`TransferCard` (cards node) renders a masked recipient phone via `./cards/maskPhone`, so no raw
phone number is shown.

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

/** A restored OUT-OF-BAND action (never a live decision, never re-invoked): `attention` says how to treat it. */
export interface PendingReconciliation { summary: PendingActionSummary; actionId: string;
  attention: OutOfBandAttention; }   // 'processing' | 'recoverable' | 'reconciliation'

export interface UseAgentStreamResult {
  messages: ChatMessage[];
  toolEvents: ToolEventView[];
  activePlan?: TaskPlan;
  pendingAction?: PendingHumanDecision;              // { kind, summary, actionId, hint? }
  pendingReconciliations: PendingReconciliation[];   // restored OUT-OF-BAND rows (processing/recoverable/reconciliation)
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
  recover(actionId: string): Promise<void>;          // POST /api/actions/:id/recover
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
  busy?: boolean; placeholder?: string; className?: string; draft?: { content: string }; }
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
  recover: (actionId: string) => string;       // default `/api/actions/${id}/recover`
  task:    (id: string) => string;             // default `/api/tasks/${id}` — read/control ONE persisted plan
  actions: string;                             // default '/api/actions' — list the session's attention rows
}
export const DEFAULT_ENDPOINTS: ChatEndpoints;
export function sendChatTurn(req: ChatTurnRequest, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function confirmAction(actionId: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function verifyAction(actionId: string, code: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function cancelAction(actionId: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
export function recoverAction(actionId: string, endpoints?: ChatEndpoints): Promise<ChatTurnResponse>;
// NEVER-throwing plan read (refresh recovery): resolves the plan, else undefined on
// non-ok / error-envelope / malformed body / exception. Never surfaces a raw error to the UI.
export function fetchTaskPlan(id: string, endpoints?: ChatEndpoints): Promise<TaskPlan | undefined>;
// POST the SAME `task(id)` URL with `{ action }`; resolves the post-control snapshot, else undefined.
export function controlTask(id: string, action: TaskControlAction, endpoints?: ChatEndpoints): Promise<TaskPlan | undefined>;
// GET `actions`; requires `{ ok:true, data: [...] }` with complete current rows; keeps ACTIONABLE
// (pending | awaiting_mfa) rows AND OUT-OF-BAND rows (`confirmed` in-flight/recoverable +
// TERMINAL needs_reconciliation) — the latter carry no confirm/MFA path but must be SHOWN so the
// user sees their state and can reconcile/recover. Each ref requires the explicit server
// `attention` classification. Best-effort reads resolve `[]` on any failure; malformed rows are discarded.
export interface PendingActionRef { id: string; status: PendingActionStatus; tier: RiskLevel;
  requiresMfa: boolean; summary: PendingActionSummary; attention: AttentionClass; }
export function fetchPendingActions(endpoints?: ChatEndpoints): Promise<PendingActionRef[]>;
export type { TaskControlAction, AttentionClass, OutOfBandAttention };  // re-exported from the chat barrel
```

`postAction` (the confirm/verify/cancel/**recover** path) maps the `ActionResponse` to events
defensively: an **escalation / MFA-prompt** outcome (`requiresMfa && tier === 'RED' && !executed`, not
a failed code) gets an `mfa_required` `AgentStreamEvent` ensured (synthesised when the server omitted
one) and is **not** turned into a spurious `error`; any other `ok:false` outcome gets an `error` event
appended when the server sent none (e.g. a wrong MFA code arrives as `ok:false` +
`status:'awaiting_mfa'` + `mfaResult:'failed'` with an EMPTY event list). `recoverAction` reuses the
same normalisation, so a failed recovery is a safe event list, never a raw throw. For a TERMINAL
server `status` (`executed` / `failed` / `cancelled` / `needs_reconciliation`) it also appends the
ADDITIVE `action_settled` event (see the fold table) so a settled decision card stops looking
actionable.

## Attention classes (additive `GET /api/actions` field)

`GET /api/actions` returns the caller session's complete current rows in the success envelope.
Each row requires `attention: AttentionClass`
(`'decision' | 'processing' | 'recoverable' | 'reconciliation'`). Missing classification or policy
fields, obsolete response shapes and flat summary views are rejected without reconstruction.
The explicit server classification decides the UI treatment:

| `attention` | trigger | treatment |
| --- | --- | --- |
| `decision` | `pending` / `awaiting_mfa` | the ONE live human-decision card (`ConfirmationCard` / `MfaCard`) |
| `processing` | `confirmed` with an ACTIVE persisted lease | `ReconciliationCard` "处理中" — **no button** (work is still owned by a live continuation) |
| `recoverable` | result-less `confirmed` wedge, no lease (server may settle it) | `ReconciliationCard` "可恢复" + 恢复执行 button |
| `reconciliation` | terminal `needs_reconciliation` | `ReconciliationCard` "待人工核对" + 恢复执行 button |

Only rows whose `status` is `pending | awaiting_mfa | confirmed | needs_reconciliation` become a
`PendingActionRef`; every other `status` (`executed` / `failed` / `cancelled` / `locked`) is dropped.
The `AttentionClass` / `OutOfBandAttention` types live in `./cards/types.ts` (re-exported through
`./cards` and the chat barrel) so the fetch helper and the card agree on one definition.

## Event → state fold (consumed by `useAgentStream` / `ChatWindow`)

The fold is implemented as a **separately-exported PURE reducer** `reduceAgentEvents(state, events):
ChatUIState` (plus `initialChatUIState()` and the `ChatUIState` type) so it is unit-testable with
`AgentStreamEvent[]` fixtures and **no DOM**. `useAgentStream` merely wraps it in `useState`.
`pendingReconciliations` is NOT event-driven — it is seeded only by the refresh-restore effect (below).

| `AgentStreamEvent` | state effect |
| --- | --- |
| `session` | set `sessionId` (persist for later turns) |
| `message_start` | append the exact message row; only an assistant start changes the prose preview owner |
| `text_delta` | append `delta` to `streamingText` |
| `message_end` | finalise the owning message, preserve client-folded plans and terminal calls; clear `streamingText` only when ending the current assistant |
| `tool_start` / `tool_end` | update the exact tool row by messageId and call identity; gated calls carry an exact actionId |
| `card` | append a business card only to its explicitly owned tool row; a plan card updates the one historical card for that plan ID |
| `plan_update` | update the same historical plan card under its generation and terminal-state fences; update `activePlan` only when this is the same or a newer-created plan |
| `confirmation_required` | set `pendingAction` `{ kind: 'confirmation', summary: event.action, actionId: event.actionId }` |
| `mfa_required` | set `pendingAction` `{ kind: 'mfa', summary: mfaSummary(state, event.hint), actionId: event.actionId, hint: event.hint }`; the summary's `toolName` is the actual gated tool the stream reported as blocked, omitted when the stream carried none |
| `action_settled` (typed `AgentStreamEvent`) | stamp terminal status onto exactly matched action cards and tool events, then clear that action's live decision; never match another stamped action by summary alone |
| `security_event` | append a `system` `ChatMessage` (content = `event.message`; `event.kind` is not surfaced) |
| `error` | set `error` (never throw to the UI) |
| `done` | clear `busy` |

The MFA summary's `hint` is carried on `pendingAction.hint` so `ChatWindow` can render it; `pull()`
folds the events FIRST (so an `action_settled` signal still sees the decision it belongs to), then
applies the settle rule: `pendingAction` is cleared after a NON-error turn UNLESS that same turn
carries a decision-establishing event — a `confirmation_required`/`mfa_required` (a fresh YELLOW/RED
gate, or a YELLOW→RED escalation response, which carries no `error`) keeps its decision so the card
stays actionable. A domain `error` likewise keeps the decision visible so the user can retry.

### Plan dedupe (at most ONE plan view per plan id) + generation fence

Plan cards and `plan_update` events both flow through `upsertPlan` and `placePlanInHistory`:

- Each plan appears once inside its owning tool message, rendered through `CardRenderer`.
  Later snapshots update that card in place, including after authorization or execution recovery.
- Successful and cancelled plans remain historical records. A new user turn never moves them to
  the conversation bottom. An actionable plan without a historical card may use a fallback panel.
- `activePlan` tracks the latest plan for default task controls; it is not an unconditional rendered
  footer. Every historical control supplies its own plan ID.
- When a crash leaves no provider message, a synthetic historical record is inserted at the plan's
  creation time as an independent system workflow row instead of attaching it to a later reply.

**Generation fence (执行代次/版本).** `TaskPlan.generation` is bumped by the agent layer whenever the
plan's execution token is (re)claimed (initial claim or a stale-owner takeover), and the `plan_update`
`AgentStreamEvent` also carries an optional `generation`. `upsertPlan(state, plan, generation?)` uses
`plan.generation ?? generation` as the incoming value and fences it against the stored plan for the
SAME id:

- both sides present → an **older** incoming generation is **rejected** (returns the state unchanged),
  an incoming generation that is **equal or newer** **wins** even when `updatedAt` is equal/older;
- **either** side missing a generation → the `updatedAt` ordering guard
  (`current.updatedAt > plan.updatedAt` → keep) applies;
- incoming event-only generations are stamped onto the accepted snapshot for later comparisons;
- a cancelled plan cannot become nonterminal; a successful plan can stay successful or be explicitly
  cancelled for supported record compensation, but cannot reopen from a stale progress snapshot;
- a snapshot for an older plan updates its own history without replacing the latest plan identity.

The same folding path handles `plan_update`, plan `card` events, `message_end` snapshots,
mount-time plan recovery and task-control responses.

### Permission request dock (exactly one active decision)

`ChatWindow` renders `ApprovalRequest` above the composer, outside the scrollable transcript.
It uses `stream.pendingAction`: `kind === 'confirmation'` → `ConfirmationCard`,
`kind === 'mfa'` → `MfaCard` (both reused from `./cards`, never forked). They share
the SAME `CardActionHandlers` bundle built in `ChatWindow`, so confirm/verify/cancel POST to the
`./app` routes — the browser never executes a banking op and no parallel confirm flow exists.

The request remains available even when its historical owner is outside loaded pagination.
`CardRenderer` renders confirmation/MFA metadata as `ApprovalRecord`, never permission controls.
The record shows the initial requirement and authoritative current state, with expandable business
details. A new action ID remounts its verification form; no code draft carries across actions.
Requests receive keyboard focus without scrolling the transcript and never trap navigation.

### Settled-action status (a TERMINAL status stops looking actionable, on BOTH surfaces)

A gated action can settle on a later turn (an `action_settled` signal, or a `status`-carrying
response): a terminal status clears the request and updates the original read-only receipt.

| status | badge |
| --- | --- |
| `executed` | 已执行 |
| `failed` | 失败 (+ the server reason) |
| `cancelled` | 已取消 |
| `needs_reconciliation` | 需人工核对 |

`confirmed` is processing, not success. Only `executed` reports authorized completion.
Cancelled, failed, locked and unknown outcomes remain distinct. Wrong verification attempts keep
the active request. Settlement uses exact action IDs, with `decisionKey` only for unstamped legacy
summary matching; the display layout does not decide authorization or infer completion.

### Out-of-band card (one per restored attention row)

`ChatWindow` renders one `ReconciliationCard` per `pendingReconciliations` entry, passing the row's
`attention` so it shows the right state (处理中 / 可恢复 / 待人工核对). It is visually distinct from
`ConfirmationCard` (🟡 tier badge + 确认/取消) and `MfaCard` (🔴 code entry) — an amber/blue banner and
a left accent border, never a `StatusBadge` — so it can never be mistaken for a live 🟡/🔴 decision.

The 恢复执行 button (only for `recoverable` / `reconciliation`) calls `CardActionHandlers.onRecover`
(`stream.recover`), which POSTs `/api/actions/:id/recover`; **the browser never replays a banking op
itself** — the server re-checks ownership and settles the action through the gateway's authorized
path. A `processing` row renders NO button (the work is still owned by a live continuation).

### Refresh recovery

`ChatWindow` takes an optional `taskId` threaded into `useAgentStream`. On mount the hook:

- fetches only the server-selected `taskId` for the current conversation history boundary;
  browser plan hints are not used, so a developer reset cannot restore a historical plan;
- never overwrites a plan a live `plan_update` already delivered, and ignores a stale/unmounted or
  failed fetch (an `alive` cleanup flag; `fetchTaskPlan` resolves `undefined` instead of throwing).

Before client mounting, `/agent` restores all plans inside the current history boundary from
persisted task/node rows. `app/agent/plan-history.ts` resolves the original provider run and
`submit_plan` call, then updates the owning message through `lib/chat-plan-history.ts`. Repeated
authorization publications cannot change the message's original run. The server selects only an
actionable task for `taskId`; completed plans are restored as history without a footer recovery.

**Pending-action + out-of-band refresh restore.** For a server-provided session, a second mount effect runs
`fetchPendingActions()` (an out-of-band row carries no live decision of its own, so it must be read
even when a decision is already showing), then rebuilds two independent things:
  - the ACTIVE human decision in the single `pendingAction` slot (so a reloaded page still shows the
  confirm/MFA card for an in-flight action) — the MOST RELEVANT ACTIONABLE row wins:
  `requiresMfa || status === 'awaiting_mfa' || tier === 'RED'` → the `mfa` kind, else the
  `confirmation` kind (an out-of-band row is NEVER picked as a decision);
- `pendingReconciliations` — every OUT-OF-BAND row (`attention !== 'decision'`), each carrying its
  `attention` so `ChatWindow` renders the matching `ReconciliationCard` state.

`restoring` is `true` while that read is in flight. Same guards as the plan recovery: an `alive`
cleanup flag, a functional `setState` that refuses to clobber a non-undefined `pendingAction` (or a
non-empty `pendingReconciliations`) already delivered by a live event, and a best-effort `[]` on
failure — it NEVER throws to the UI.

### Recovery entry (`recover`)

`useAgentStream.recover(actionId)` runs the shared `pull()` over `recoverAction`, folding the returned
events like any other action. The typed `action_settled` event converges both decision cards and
`pendingReconciliations`: known final outcomes remove recovery controls; `needs_reconciliation`
converts the entry to manual attention and preserves an active decision's summary immediately.
A transport failure leaves the entry available. Cleanup never depends on the absence of an error.
It never throws to the UI.

### Plan control (pause / resume / cancel / retry)

`useAgentStream.controlTask(action, planId?)` (defaulting `planId` to `state.activePlan?.id`) POSTs
`endpoints.task(id)` with `{ action }` via `controlTask` and folds the returned post-control snapshot
into that plan's original historical card (reusing `upsertPlan`). It sets `busy` around the call
and, on failure (`undefined`), surfaces a SAFE `error`; never throws. `ChatWindow` exposes it through
`CardActionHandlers.onTaskControl(action, planId?)`. `CardRenderer` binds the rendered plan's ID for
every control, so an older plan's pause/resume/cancel/retry button cannot act on the newest plan.

### MFA attempt counter

`ChatUIState.mfaAttempts` counts CONSECUTIVE failed verifications for the ACTIVE decision. `verify()`
increments it (post-`pull`, functional `setState`) only when the turn ends with an `mfa` `pendingAction`
still active AND an `error` set (a wrong code). An effect keyed on `pendingAction.actionId` + `kind`
resets it to `0` whenever the decision settles/clears or is replaced (success, cancel, or a new turn).
`ChatWindow` threads it into `MfaCard.attempts` via `CardActionHandlers.mfaAttempts`.

## Known Issues

- `applyEvent` has a `default: return state` branch (no `assertNever`) — a NEW `AgentStreamEvent` variant silently no-ops instead of failing compilation (contrast `CardRenderer`'s exhaustive guard).
- `security_event` drops `event.kind` and is rendered as a `system` message, not a banner.

## Constraints

- **All Client Components** (`'use client'`) — hooks, streaming, fetch.
- **The browser never executes a banking op.** Confirm/verify/cancel/recover POST to `./app` routes; the
  server re-validates and executes. `useAgentStream` only folds the returned `ChatTurnResponse.events`.
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
  /`onRecover`/`onTaskControl`/`mfaAttempts`/`busy`/`error` **plus** the anomaly handlers
  `onAcknowledge`/`onViewDetail`/`onFreeze`. `onTaskControl` is `stream.controlTask`, `onRecover` is
  `stream.recover`; the anomaly three are fire-and-forget `stream.send(...)` calls
  (「这笔交易是我本人消费」/「我想查看这笔交易的详情」/「冻结我的银行卡」),
  so every anomaly button flows chat → agent → Security Gateway as an ordinary user message — the browser
  never calls a banking op directly; the gateway applies the configured operation policy.
- `ChatWindow` renders plans inside historical messages, with exact plan IDs for task controls.
  Only an actionable plan absent from history gets a fallback `PlanCard`. While restoring with
  nothing else to show, the page displays a `Spinner` and loading label instead of the empty state.

## Test Strategy

- `useAgentStream` is a **pure fold** over `AgentStreamEvent[]` → unit-test it with scripted event
  sequences (from the faux-provider scenarios) under the root `tests/` suite: card attachment,
  plan history/upsert (one plan view per id), the generation fence (an older generation for the same
  id is rejected; an equal-or-newer one wins over an equal/older `updatedAt`), tool-event upsert, confirmation/mfa
  transitions with `kind`, error→banner, done→idle.
- Regression suites cover completion followed by an unrelated turn, refresh restoration by exact
  run/call ownership, historical controls, crash-orphan positioning, late terminal snapshots and
  developer history-boundary filtering. Browser journeys assert the same ordering after refresh.
- **No component/DOM test layer exists** — `@testing-library/react`/`jsdom`/`happy-dom` are NOT dependencies and `vitest.config.ts` runs `environment: 'node'`.
  There is NO `useAgentStream`/`ChatWindow`/`Composer` test; DOM coverage is ONLY the real-browser suite `tests/e2e/acceptance.e2e.ts` (playwright-core, `npx tsx`, NOT Vitest).
- `tests/unit/planner/action-contract.test.ts` verifies current response envelopes, complete policy and
  summary fields, explicit attention, rejection of obsolete shapes and preservation of MFA and settlement events.
- `tests/unit/planner/chat-stream.test.ts` verifies incremental delivery, durable identity preservation
  across reader failures, missing completion signals, and complete JSON chat response contracts.
- `tests/unit/planner/action-attention-state.test.ts` verifies restored attention convergence and
  immediate manual reconciliation visibility after an uncertain terminal outcome.
- **Untested fold rules of thumb** (candidates, NOT existing tests): a restored action fixture with
  actionable AND out-of-band rows (`confirmed` → `processing`/`recoverable`, `needs_reconciliation` →
  `reconciliation`) should rebuild the decision slot AND the `pendingReconciliations` list (one
  `ReconciliationCard` per row, with a 恢复执行 button only for `recoverable`/`reconciliation`) without
  clobbering a live decision; `Composer` should be enter-to-send and disabled-when-busy.

## Routing Table

- `./ChatWindow.tsx` → container: message list + live plan + active decision card + out-of-band cards + composer, owns `useAgentStream`
- `./MessageBubble.tsx` → a prose message, independent tool result, or standalone workflow record
- `./Composer.tsx` → input + send
- `./ToolEventList.tsx` → tool/task status timeline (no chain-of-thought)
- `./StreamingText.tsx` → validated complete assistant text and safe reply progress
- `./useAgentStream.ts` → the event→state hook (chat state machine, with the plan generation fence + the additive `action_settled` settle fold) + refresh recovery (plan, pending action AND out-of-band attention) + recovery entry + plan control + MFA attempt counter
- `./actions.ts` → typed client fetch helpers + `ChatEndpoints`/`DEFAULT_ENDPOINTS`/`fetchTaskPlan`/`controlTask`/`fetchPendingActions`/`recoverAction` + the `PendingActionRef` attention mapping + the additive `action_settled` emission for a TERMINAL `status`
- `./decisionKey.ts` → the status-independent identity key shared by inline decision detection and settle-matching
- `./cards/` → the `ChatCard` renderers + `CardRenderer` dispatcher + the non-union `ReconciliationCard` (out-of-band: processing/recoverable/reconciliation) + the `AttentionClass`/`OutOfBandAttention` types
- `./index.ts` → re-exports the chat surface + action helpers + the attention types
- `../../ui/` → primitives used here (dependency — read-only)
