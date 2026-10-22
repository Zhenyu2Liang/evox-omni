# agent/turns — ordered public presentation

## Intent

This node projects original Pi events into an ordered public transcript. It does not
classify user intent from words, rewrite model archives, authorize a banking action,
or derive execution evidence from prose. The typed turn declaration updates the
buffer's advice and protocol-example preferences through the runtime callback.
This node is presentation only: it implements no banking tools and no card tooling or card-consumption/spend/purchase/pay/debit capability (card and account tools live in `../tools/`).

## Ownership

- `buffer.current` owns the current assistant prose only. Complete prose remains
  verbatim, subject to whole-protocol format validation and bounded model repair.
- `buffer.assistants` is the ordered list of new presentation messages, including
  independent `role: tool` entries. Its historical name does not restrict message roles.
- Each tool entry has empty content, one tool event, and only its own result or
  authorization cards. `ToolEventView.messageId` identifies that entry. Provider call
  IDs alone cannot identify an owner because different responses may reuse them.
- Production IDs combine the durable run and model-request identities; a tool ID
  also includes its original call ID. Pure non-journal adapters use a redacted
  provider-message fingerprint as a fallback. A recovered original response retains
  its presentation IDs even when timestamps or call IDs are repeated.
- `toolMessages` tracks active calls within the current model response. Starting a
  later assistant clears this active lookup, while ordered transcript entries remain.

## Declared intent and preflight refusals

- The buffer does NOT store the declared `ConversationIntent` steps or a
  `planningRejections` map. `createTurnBuffer(requestText, intent)` (buffer.ts:18)
  keeps only `advisory` (purpose `advice`) and `allowProtocolExamples`; the declared
  write step list never reaches this node; the declared-vs-emitted comparison lives in
  `../write-continuation.ts` (`declaredWriteTools`/`hasWriteEvidence`, reading `runtime.serialize().intent`).
- Server-owned preflight refusals arrive as a separate
  `rejected: ReadonlyMap<toolCallId, reason>` argument to `createEventHandler`
  (events.ts:98), sourced from `BankingAgentRuntime.planningRejections`
  (banking-agent.ts:119,154) and passed at run-turn.ts:56.
- `handleToolEnd` checks `rejected.has(toolCallId)` first (events.ts:32) and projects
  the reason through `projectToolRejection` (lib/tool-feedback.ts:32) into a
  `status: 'blocked'` `ToolEventView`.

## Tool outcome projection (statuses, summary, diagnostics)

- `toolResultStatus(result)` (buffer.ts:72-81) returns ONLY `'success' | 'error' | 'needs_reconciliation'` (the latter when `data.outcome === 'unknown'`, `data.needsReconciliation === true` or `data.status === 'needs_reconciliation'`); otherwise `result.ok ? 'success' : 'error'`. It never yields `'blocked'`/`'cancelled'`/`'started'`, so an authorization resume can never publish a blocked/locked tool status.
- `publishAuthorizedToolOutcome` (buffer.ts:122-145) builds `{ toolCallId, toolName, status: toolResultStatus(input.toolResult), actionId?, summary? }`; the summary comes from `settledSummary` (buffer.ts:111-120), i.e. `input.toolResult.summary || input.toolResult.error`, with an internal diagnostic (raw `__SECURITY_BLOCK__…` payload, JSON fragment, stack trace — `lib/public-text.ts` `isInternalDiagnostic`) replaced by the `chat.error.toolFailed` catalog key so no refusal payload becomes public text. It NEVER puts `errorCode`/`errorParams` on the view, never invents a marker string, and never sets `debugDetail`. Tool business cards are emitted only when `input.toolResult.ok` (buffer.ts:142).
- In-turn `tool_execution_end` (`handleToolEnd`, events.ts:28-95): rejected → `status:'blocked'` + `projectToolRejection` (`summary` = a `chat.error.*` message key, `debugDetail` = the raw server reason); needs-reconciliation → `status:'needs_reconciliation'` with no summary; ordinary error → `status:'error'` with `summary` = parsed model error text, `errorCode`, plus an `errorCard`; prefixed security block (`security.gateway.parseBlockReason` non-null or `message.startsWith(security.gateway.BLOCK_REASON_PREFIX)`) → `status:'blocked'` carrying only typed facts (`actionId`/`errorCode`=`failure.code`/`errorParams`), then a decision prompt through `publishPendingDecision` (next section), else the structured `security_event` below. This order (needs_reconciliation → blocked → error) is the classification contract: an unknown outcome and a genuine business failure are never reported as locked.
- `ToolEventView.debugDetail` has exactly two sources in this node: `events.ts:33` (spread of `projectToolRejection`, i.e. the raw preflight refusal) and `events.ts:177` (`safeToString(error)` when presentation itself throws). Both are developer-only (`lib/contracts/agent.ts:53-54`).
- A block reason that is NOT a still-open decision (`security.gateway.parseBlockReason` null, or a `deny`/`circuit_open`/`mfa_session_locked`/`mfa_attempts_exhausted` failure) ends the handler with a STRUCTURED `security_event` (`events.ts:90-94`): `kind: 'locked'` plus only the typed `code`/`reason`/`actionId`/`attemptsLeft`/`maxAttempts` fields. The raw `__SECURITY_BLOCK__…` payload, its JSON and every internal status literal stay out of the public stream; `lib/public-text.ts` `securityNotice` renders the notice from the typed fields (`components/chat/agent-stream-reducer.ts`, `channels/weixin/banking-client.ts`). The public tool summary stays empty for a denied/locked turn.
- This node emits NO `action_settled` (nor any other settlement signal); the event type (`lib/contracts/agent.ts:99`) has no server-side producer at all — the client synthesizes it in `components/chat/actions.ts:603-611` from the HTTP action response.

## Decision prompts require the persisted open status

- A `mfa_required` / `confirmation_required` event and its `mfa`/`confirmation` card exist ONLY while the persisted `PendingAction` is still open. Both producers — the gated branches of `handleToolEnd` (events.ts:81-88) and `flushParkedDecision` — go through `publishPendingDecision` (authorization-view.ts:76-94).
- `loadParkedDecision(actionId, toolName)` (authorization-view.ts:48-52) reads `getPendingAction` (including `mfa`) and returns the row's OWN `status`, its `PendingActionSummary` re-derived from the CURRENT `riskLevel`/`requiresMfa` via `withActionPolicy`, and `mfaLocked` (`mfa.status === 'locked'`). A missing row returns `null`, which proves nothing is decidable.
- `publishPendingDecision` publishes only when `mayPromptForDecision(status)` (`../action-status.ts`, i.e. `pending`/`awaiting_mfa`). `locked` is TERMINAL (`TERMINAL_ACTION_STATUSES`): an exhausted-verification or circuit-locked action is never re-presented as a decision, never re-activated and never executed. For `locked` it pushes `settledDecisionSignal` (authorization-view.ts:61-67) — `security_event{kind:'locked', code:'MFA_LOCKED'|'CIRCUIT_OPEN', reason, actionId}`, no `message`; every other terminal status (`executed`/`failed`/`cancelled`/`needs_reconciliation`) publishes no signal because its execution evidence already owns the outcome. No internal status literal (`locked`, …) is ever interpolated into user-visible text.
- `flushParkedDecision(buffer, relay)` (authorization-view.ts:108-123) clears `relay.parkedActionId` and `relay.parkedToolName` before reading, derives the prompt kind from the persisted summary (`tier === 'RED' || requiresMfa` → `mfa`), and republishes the plan tool message only when a prompt was actually published. Its try/catch + `safeToString` is unchanged, so a persistence read failure cannot break the turn.

## Events

`events.ts` emits message start, tool start/update/end, owned cards, and a complete
tool-message end snapshot. Its full signature is `createEventHandler(buffer: TurnBuffer, now: () => number, rejected: ReadonlyMap<string, string> = new Map(), modelRequestIdentity?: () => string | undefined): (event: AgentEvent) => Promise<void>` (events.ts:98-99); `../run-turn.ts:56-57` builds it with `runtime.planningRejections` and `() => context.journal.currentModelRequestIdentity?.()`, and feeds every Pi event through `runtime.agent.subscribe(...)`. Tool completion republishes its own entry even when
presentation fails. Normal model text never accumulates tool cards or diagnostics.
The internal `describe_turn` tool stays in the Pi journal but creates no public row,
business card, or financial fact.

`readyPresentationEvents()` publishes completed prose in its original position and
withholds unfinished candidates. Tool progress and owned business cards can publish
while the next response is being generated. `card.messageId` and `plan_update.messageId`
bind their exact owners rather than selecting the latest assistant.

`authorization-view.ts` binds a plan and its parked authorization to the original
submit-plan entry. Authorization resume updates the original action/call entry and
adds its verified result card there; a later assistant remains independent.
A decision prompt is (re)published only for an action whose persisted status is
still open (`publishPendingDecision`), so a locked or otherwise settled action never
regains a verification/confirmation entry, and a settled `locked` action reports the
typed lock notice instead.

## Banking guidance envelope (`{"guidance":{...}}`)

- Path: `events.ts:126-149` (`message_end`) → `inspectReplyFormat` (`../reply-format.ts:18`) → `parseBankingGuidance` (`../banking-guidance.ts:22`) → `groundMessage` (`buffer.ts:26-37`) → `renderBankingGuidance` (`../banking-guidance.ts:47`) → `buffer.events` → `journal.recordPresentationEvent` before SSE (`../turn-runtime.ts:46-54`) → transcript snapshot (`../run-turn.ts:81-84`). `groundMessage` re-parses when `_guidance` is `undefined` (`buffer.ts:30`), and `events.ts:132-133` records `buffer.lastGuidance` only for a `stop` reply with no format issue (no reader in this node).
- Accepted codes: every `../messages/conversation.zh-CN.json` key except `unverified`/`unavailable` (`../guidance-messages.ts:3-8`), the capability codes in `../banking-guidance.ts:10-15`, plus `missing_details`/`ambiguous_selection` with 1-4 known fields. `card_management_required` and `capabilities` are both accepted; every accepted code is re-rendered from a server template, and only `fields` names travel (`banking-guidance.ts:35-38`).
- `unverified`/`unavailable` are server-authored only (`../financial-response.ts:12-13`); a model envelope naming them fails parsing and is never shown.
- `groundMessage` (buffer.ts:26-37) never creates a message and never pushes to `buffer.assistants`: it rewrites `message.content` in place on the candidate object that `buffer.current` and `buffer.assistants` already reference, and `events.ts:147-148` then emits `text_delta`/`message_end` for that same object. It touches no other buffer structure (`assistants`, `current`, `factResults`, `serverGuidance` are untouched); a format issue sets `content = ''`, and a caught error sets `content = conversationMessages.unavailable` plus an `error` event.
- `groundMessage` is idempotent per message id (`buffer.groundedIds`, buffer.ts:27/36), so the final `groundMessage(buffer, buffer.current)` in `../run-turn.ts:81` is a no-op for a reply already grounded by `events.ts`. Call sites: `events.ts:136` (prose emitted alongside a tool call), `events.ts:144` (final prose), `../run-turn.ts:81`.
- `buffer.serverGuidance` (contracts.ts:44) is declared and read (`live-prompt.ts:18`, `../durable/continuation.ts:295-317`) but assigned nowhere in the codebase, so it is always `undefined` at runtime.
- Gotchas: a model envelope with `declared_unsubmitted` is accepted, but `renderConversationGuidance` returns the raw template, so the literal `{operations}` placeholder reaches the user — substitution exists only in `../financial-response.ts:112`. An unknown code inside a single-key top-level object is dropped, but a `guidance` object plus any second top-level key escapes `reply-format.ts:33` and is rendered verbatim. A non-`stop` reply is grounded with `prose = ''` (`events.ts:143`) and yields `dialogue.zh-CN.json:emptyReply`. `allowProtocolExamples` bypasses both the format check and guidance parsing (`reply-format.ts:20`, `buffer.ts:29`).

## History and recovery

`../transcript-activity.ts` reconciles scoped invocation and authorization evidence.
Model-request identity disambiguates reused call IDs within one run. It does not
attach execution results to an unrelated narration. `../transcript-presentation.ts`
normalizes existing mixed UI entries without changing original prose or the model
archive; an ambiguous historical card remains a separate system entry.

Durable continuation restores completed presentations from original recorded model
groups and results. This restoration emits UI events only, without rerunning a
banking tool. Current model replay and the raw event journal retain their own evidence.

## Verification

Pure coverage: `tests/unit/planner/tool-timeline.test.ts`,
`tests/unit/planner/transcript-activity.test.ts`, and `tests/unit/planner/tool-feedback.test.ts`. The timeline suite checks
same-name calls, reverse completion order, exact action ownership, stable recovered
IDs, complete before/after prose, internal-tool isolation, presentation failure, and
withholding unfinished candidates. Run with `VITEST_SKIP_DB_SETUP=1` to avoid database
generation and provisioning.
`tests/unit/agent/turn-security-event.test.ts` covers the structured `security_event`
(a locked refusal carries typed fields only, no `message`, no raw payload).
Known gap: `tests/helpers/scenario.ts` keeps its own copy of the tool-end
classification for scenario/HTTP suites and does not read the persisted
`PendingAction` status, so the open-status gate for decision prompts is enforced only
by production `agent/turns/`.

## Live-prompt flow and declared writes

`turns/live-prompt.ts` `runLivePrompt` (l.71) awaits `runtime.agent.prompt(request)` (l.77), then `../write-continuation.ts` `continueDeclaredWrites` (l.83), then `repairConversationalReply` (l.84); its signature is `runLivePrompt(runtime, buffer, request, now, config?: AppConfig)`.
`runLivePrompt` has NO `llmMode` guard of its own: it only forwards `config` into `continueDeclaredWrites(runtime, buffer, now, { config })` (live-prompt.ts:88), and the single live gate reachable from this node is `../write-continuation.ts:57` `if (config?.llmMode !== 'live') return undefined;` inside `pendingDeclaredWrites`. A turn run without `config` (or in mock mode) therefore never spends the continuation and never publishes `declared_unsubmitted`.
`runLivePrompt` calls neither `flushParkedDecision` nor `publishServerReply`: `../run-turn.ts:67` runs `flushParkedDecision` in its `finally`, and `publishServerReply` is reached only from `repairConversationalReply` (live-prompt.ts:68), `../write-continuation.ts:126` and `../run-turn.ts:71`.
`runLivePrompt` returns the failure string instead of throwing: `findRunFailure` over the messages added by the prompt (l.78-79) and over the last message after the continuation steps (l.90-91).
`repairConversationalReply` returns immediately when `!buffer.conversational` (see `createTurnBuffer`), when `buffer.serverGuidance` is set, when a `confirmation_required`/`mfa_required` event exists (l.18-19), or when the last assistant is not a `stop` reply (l.21); its corrective instruction, budget state and candidate digests are persisted before the single `runtime.agent.continue()`. `continueDeclaredWrites` runs only in live mode and only when a `describe_turn` intent declared a write-effect tool (`declaredWriteTools`) and the buffer shows no controlled write evidence (`hasWriteEvidence`); it spends exactly one persisted continuation and, if the write is still unsubmitted, the server publishes the authoritative `declared_unsubmitted` reply (`renderFinancialResponse(buffer.factResults, { declared })`). A real confirmation/MFA card is still produced only by a blocked gateway call, and only through `publishPendingDecision`'s open-status gate (`events.ts:81-88`, `authorization-view.ts`); model prose never creates one.
`turns/server-reply.ts` owns the two shared presentation primitives: `retireUnpublishedReply` (drop only an unpublished candidate's own events) and `publishServerReply` (append grounded server-authored prose without another provider call).
