# components/chat — Chat surface (messages, tool timeline, streaming)

## Intent

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
| `message_start` | append the message (pending assistant/user turn) |
| `text_delta` | append `delta` to `streamingText` |
| `message_end` | finalise message content/cards; clear `streamingText` |
| `tool_start` / `tool_end` | upsert a `ToolEventView` (status started→success/error/blocked); a `blocked` entry also records its `toolName` |
| `card` | append `card` to the current assistant message's `cards` — **except a `plan` card**, which is promoted into `activePlan` (never an inline card); see "Plan dedupe" |
| `plan_update` | UPSERT `activePlan` under the **generation fence** (see "Plan dedupe"): an OLDER generation for the same id is rejected, an equal-or-NEWER one wins, and a missing generation falls back to the `updatedAt` guard; a different id replaces the slot (one live plan at a time) |
| `confirmation_required` | set `pendingAction` `{ kind: 'confirmation', summary: event.action, actionId: event.actionId }` |
| `mfa_required` | set `pendingAction` `{ kind: 'mfa', summary: mfaSummary(state, event.hint), actionId: event.actionId, hint: event.hint }`; the summary's `toolName` is the actual gated tool the stream reported as blocked, omitted when the stream carried none |
| `action_settled` (typed `AgentStreamEvent`) | emitted by `actions.ts#postAction` for a terminal current action response: stamps the server status and message onto the matching inline confirmation card and clears the live decision for that same action |
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

Plan cards and `plan_update` events both flow through `upsertPlan` into the single `activePlan` slot:

- A `card` of type `plan` is **promoted** into `activePlan` and is NOT appended as an inline message
  card (so `CardRenderer`'s `plan` branch is not the live path — `activePlan` is).
- `ChatWindow` renders that ONE live plan via `PlanCard`, so node statuses advance on `plan_update`.
- Consequence: a `card`/`plan_update` pair for the same plan id can never leave a duplicate or stale
  plan card behind — there is exactly one plan surface per plan id.

**Generation fence (执行代次/版本).** `TaskPlan.generation` is bumped by the agent layer whenever the
plan's execution token is (re)claimed (initial claim or a stale-owner takeover), and the `plan_update`
`AgentStreamEvent` also carries an optional `generation`. `upsertPlan(state, plan, generation?)` uses
`plan.generation ?? generation` as the incoming value and fences it against the stored plan for the
SAME id:

- both sides present → an **older** incoming generation is **rejected** (returns the state unchanged),
  an incoming generation that is **equal or newer** **wins** even when `updatedAt` is equal/older;
- **either** side missing a generation → "no fence info" → the backward-compatible `updatedAt` guard
  (`current.updatedAt > plan.updatedAt` → keep) applies;
- a DIFFERENT plan id still replaces the slot unconditionally (the fence is per-id).

All three `upsertPlan` callers are covered: `case 'plan_update'` (passes `event.generation`), the
`plan` card promotion, and `controlTask` (folds the POST snapshot).

### Human-decision card (exactly ONE per active action)

`ChatWindow` renders the active decision from `stream.pendingAction`: `kind === 'confirmation'` →
`ConfirmationCard`, `kind === 'mfa'` → `MfaCard` (both reused from `./cards`, never forked). They share
the SAME `CardActionHandlers` bundle built in `ChatWindow`, so confirm/verify/cancel POST to the
`./app` routes — the browser never executes a banking op and no parallel confirm flow exists.

If the agent ALSO emits a matching inline `confirmation`/`mfa` `card`, `ChatWindow` suppresses that
duplicate (`withoutDuplicateDecisionCard`, matched by `actionId` for MFA and by `decisionKey(action)`
for confirmation) so exactly one card is visible for the active action; a message left empty by the
removal is dropped (no empty bubble). Older/unrelated decision cards are preserved.

### Settled-action status (a TERMINAL status stops looking actionable, on BOTH surfaces)

A gated action can settle on a later turn (an `action_settled` signal, or a `status`-carrying
response): a TERMINAL status replaces the 取消/确认 controls with a single status badge on BOTH
surfaces — the live decision clears and the inline card is stamped.

| status | badge |
| --- | --- |
| `executed` | 已执行 |
| `failed` | 失败 (+ the server reason) |
| `cancelled` | 已取消 |
| `needs_reconciliation` | 需人工核对 |

A NON-terminal or ABSENT status keeps the buttons (today's behaviour). The badge text/tone come from
the cards node's `terminalStatusView`; this layer only supplies the status — via the `ConfirmationCard`
`status`/`statusMessage` props (`ChatWindow#PendingDecisionCard`) or by stamping the runtime
`status`/`message` fields onto the inline card's `action` (the `action_settled` fold). Duplicate
suppression and settle-matching use `decisionKey` (a status-independent summary identity) in
`./decisionKey.ts`, so a stamped runtime status never defeats either.

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

- fetches `taskId` when provided, otherwise the last-seen plan id persisted in `sessionStorage`
  (`banking-agent:activePlanId`, written whenever `activePlan` changes);
- never overwrites a plan a live `plan_update` already delivered, and ignores a stale/unmounted or
  failed fetch (an `alive` cleanup flag; `fetchTaskPlan` resolves `undefined` instead of throwing).

**Pending-action + out-of-band refresh restore.** A second one-shot mount effect ALWAYS runs
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
events like any other action. On **success** (no `error` folded) the row is dropped from
`pendingReconciliations`; on a **failure** it is kept so the user can retry. It never throws to the UI.

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
- **The generation fence is PER plan id.** A snapshot for a DIFFERENT `plan.id` still replaces the
  `activePlan` slot unconditionally (only one plan is live at a time — the intended behaviour), so a
  stale snapshot carrying another id is not fenced.
- **`applyEvent` ends in a silent `default: return state`** — no `assertNever` — so a NEW
  `AgentStreamEvent` variant is NOT a compile error here and would silently no-op (unlike `ChatCard`,
  which IS `assertNever`-guarded in `CardRenderer`).

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
  never calls a banking op directly (the freeze button drives `freeze_card`, which the gateway routes YELLOW
  → user confirmation).
- `ChatWindow` renders the live plan with control wiring (`<PlanCard plan={stream.activePlan}
  onControl={action.onTaskControl} busy={stream.busy} />`) and, while `stream.restoring` with nothing
  else to show, a `Spinner` + loading label **instead of** the empty state.

## Test Strategy

- `useAgentStream` is a **pure fold** over `AgentStreamEvent[]` → unit-test it with scripted event
  sequences (from the faux-provider scenarios) under the root `tests/` suite: card attachment,
  plan promotion/upsert (one plan view per id), the generation fence (an older generation for the same
  id is rejected; an equal-or-newer one wins over an equal/older `updatedAt`), tool-event upsert, confirmation/mfa
  transitions with `kind`, error→banner, done→idle.
- **No component/DOM test layer exists** — `@testing-library/react`/`jsdom`/`happy-dom` are NOT dependencies and `vitest.config.ts` runs `environment: 'node'`.
  There is NO `useAgentStream`/`ChatWindow`/`Composer` test; DOM coverage is ONLY the real-browser suite `tests/e2e/acceptance.e2e.ts` (playwright-core, `npx tsx`, NOT Vitest).
- `tests/unit/planner/action-contract.test.ts` verifies current response envelopes, complete policy and
  summary fields, explicit attention, rejection of obsolete shapes and preservation of MFA and settlement events.
- **Untested fold rules of thumb** (candidates, NOT existing tests): a restored action fixture with
  actionable AND out-of-band rows (`confirmed` → `processing`/`recoverable`, `needs_reconciliation` →
  `reconciliation`) should rebuild the decision slot AND the `pendingReconciliations` list (one
  `ReconciliationCard` per row, with a 恢复执行 button only for `recoverable`/`reconciliation`) without
  clobbering a live decision; `Composer` should be enter-to-send and disabled-when-busy.

## Routing Table

- `./ChatWindow.tsx` → container: message list + live plan + active decision card + out-of-band cards + composer, owns `useAgentStream`
- `./MessageBubble.tsx` → one message (text + cards via `./cards/CardRenderer` + tool events)
- `./Composer.tsx` → input + send
- `./ToolEventList.tsx` → tool/task status timeline (no chain-of-thought)
- `./StreamingText.tsx` → incremental assistant text
- `./useAgentStream.ts` → the event→state hook (chat state machine, with the plan generation fence + the additive `action_settled` settle fold) + refresh recovery (plan, pending action AND out-of-band attention) + recovery entry + plan control + MFA attempt counter
- `./actions.ts` → typed client fetch helpers + `ChatEndpoints`/`DEFAULT_ENDPOINTS`/`fetchTaskPlan`/`controlTask`/`fetchPendingActions`/`recoverAction` + the `PendingActionRef` attention mapping + the additive `action_settled` emission for a TERMINAL `status`
- `./decisionKey.ts` → the status-independent identity key (`decisionKey`) shared by duplicate suppression (`ChatWindow#isDuplicateDecisionCard`) and settle-matching (`settleAction`)
- `./cards/` → the `ChatCard` renderers + `CardRenderer` dispatcher + the non-union `ReconciliationCard` (out-of-band: processing/recoverable/reconciliation) + the `AttentionClass`/`OutOfBandAttention` types
- `./index.ts` → re-exports the chat surface + action helpers + the attention types
- `../../ui/` → primitives used here (dependency — read-only)
