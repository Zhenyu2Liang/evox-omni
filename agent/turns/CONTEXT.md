# agent/turns — ordered public presentation

## Intent

This node projects original Pi events into an ordered public transcript. It does not
classify user intent from words, rewrite model archives, authorize a banking action,
or derive execution evidence from prose. The typed turn declaration updates the
buffer's advice and protocol-example preferences through the runtime callback.

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
  write step list never reaches this node, so no declared-vs-emitted comparison exists here.
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

## Notes for Agents — model-prose acceptance vs. execution evidence
Presentation never verifies that a model's "waiting for confirmation / please confirm in the
panel" prose is backed by a real decision. `groundMessage` (`buffer.ts:25`) accepts any
format-valid prose; it only runs `inspectReplyFormat` and `parseBankingGuidance`, never a
tool-evidence check. The only confirmation signals are the `confirmation_required` /
`mfa_required` events and cards produced from an actual blocked gateway call in `handleToolEnd`
(`events.ts:61-71`) and `flushParkedDecision` (`authorization-view.ts:36-51`).
`buffer.factResults` (`events.ts:33,45,54`) accumulates executed-tool evidence.
The lifecycle points where the model has finished its final assistant message are
`runLivePrompt` (`live-prompt.ts:92-107`, after `runtime.agent.prompt`) and `performTurn`
(`run-turn.ts:66-82`); `repairConversationalReply` (`live-prompt.ts:25-77`) is the existing
template for a bounded `runtime.agent.continue()` nudge. `buffer.advisory` is established here
(`buffer.ts:20`, `run-turn.ts:51`) but only consumed outside this node.
