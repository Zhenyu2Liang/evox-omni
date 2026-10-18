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
  `planningRejections` map. `createTurnBuffer(requestText, intent)` (buffer.ts:17)
  keeps only `advisory` (purpose `advice`) and `allowProtocolExamples`; the declared
  write step list never reaches this node; the declared-vs-emitted comparison lives in
  `../write-continuation.ts` (`declaredWriteTools`/`hasWriteEvidence`, reading `runtime.serialize().intent`).
- Server-owned preflight refusals arrive as a separate
  `rejected: ReadonlyMap<toolCallId, reason>` argument to `createEventHandler`
  (events.ts:77), sourced from `BankingAgentRuntime.planningRejections`
  (banking-agent.ts:119,154) and passed at run-turn.ts:56.
- `handleToolEnd` checks `rejected.has(toolCallId)` first (events.ts:21) and projects
  the reason through `projectToolRejection` (lib/tool-feedback.ts:32) into a
  `status: 'blocked'` `ToolEventView`.

## Events

`events.ts` emits message start, tool start/update/end, owned cards, and a complete
tool-message end snapshot. Tool completion republishes its own entry even when
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

## Banking guidance envelope (`{"guidance":{...}}`)

- Path: `events.ts:105-128` (`message_end`) → `inspectReplyFormat` (`../reply-format.ts:18`) → `parseBankingGuidance` (`../banking-guidance.ts:22`) → `groundMessage` (`buffer.ts:25-36`) → `renderBankingGuidance` (`../banking-guidance.ts:47`) → `buffer.events` → `journal.recordPresentationEvent` before SSE (`../turn-runtime.ts:46-54`) → transcript snapshot (`../run-turn.ts:81-84`). `groundMessage` re-parses when `_guidance` is `undefined` (`buffer.ts:29`), and `events.ts:111-112` records `buffer.lastGuidance` only for a `stop` reply with no format issue (no reader in this node).
- Accepted codes: every `../messages/conversation.zh-CN.json` key except `unverified`/`unavailable` (`../guidance-messages.ts:3-8`), the capability codes in `../banking-guidance.ts:10-15`, plus `missing_details`/`ambiguous_selection` with 1-4 known fields. `card_management_required` and `capabilities` are both accepted; every accepted code is re-rendered from a server template, and only `fields` names travel (`banking-guidance.ts:35-38`).
- `unverified`/`unavailable` are server-authored only (`../financial-response.ts:12-13`); a model envelope naming them fails parsing and is never shown.
- Gotchas: a model envelope with `declared_unsubmitted` is accepted, but `renderConversationGuidance` returns the raw template, so the literal `{operations}` placeholder reaches the user — substitution exists only in `../financial-response.ts:112`. An unknown code inside a single-key top-level object is dropped, but a `guidance` object plus any second top-level key escapes `reply-format.ts:33` and is rendered verbatim. A non-`stop` reply is grounded with `prose = ''` (`events.ts:122`) and yields `dialogue.zh-CN.json:emptyReply`. `allowProtocolExamples` bypasses both the format check and guidance parsing (`reply-format.ts:20`, `buffer.ts:29`).

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

## Live-prompt flow and declared writes

`turns/live-prompt.ts` `runLivePrompt` (l.71) awaits `runtime.agent.prompt(request)` (l.77), then `../write-continuation.ts` `continueDeclaredWrites` (l.83), then `repairConversationalReply` (l.84). `continueDeclaredWrites` runs only in live mode and only when a `describe_turn` intent declared a write-effect tool (`declaredWriteTools`) and the buffer shows no controlled write evidence (`hasWriteEvidence`); it spends exactly one persisted continuation and, if the write is still unsubmitted, the server publishes the authoritative `declared_unsubmitted` reply (`renderFinancialResponse(buffer.factResults, { declared })`). A real confirmation/MFA card is still produced only by a blocked gateway call (`events.ts:61-71`, `authorization-view.ts`); model prose never creates one.
`turns/server-reply.ts` owns the two shared presentation primitives: `retireUnpublishedReply` (drop only an unpublished candidate's own events) and `publishServerReply` (append grounded server-authored prose without another provider call).
