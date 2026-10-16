# Durable agent runtime context

The durable layer persists every observed Pi event, run lease, stable tool invocation, model request and checkpoint so an interrupted agent run can be recovered from original evidence without inventing effects. Flat directory — no child nodes; all modules live directly here.

## Intent
- Persist-first journal: copy and store each Pi `AgentEvent` before transforms, effects, or SSE publication.
- Recover the original decision path — a model checkpoint or a standalone workflow graph — rather than creating a replacement operation.
- Own the run lease and the stable invocation identity that the security gateway and bank commands fence against.

## API Surface
- `journal.ts` — `AgentRunJournal` (record raw/ui/internal/model events + invocations, `assertLeaseOwned`, `parkInvocation`, `startHeartbeat`, `finish`) and `beginRun`.
- `retry-policy.ts` — `toolReplayPolicy` and `decideInvocationRetry` (decisions only, execute nothing).
- `recovery.ts` — `inspectRunRecovery`, `readRunPresentation`, `wakeRecoverableRuns`, `recoverInvocation` plus the `InvocationRecoveryPort` (receipt read / execute / classifyFailure).
- `service.ts` — `getOwnedRunSummary`, `recoverOwnedRun` (explicit owned recovery entry used by the HTTP route).
- `continuation.ts` — `continueDurableRun`, `restoreWaitingCheckpoint` (model-checkpoint continuation).
- `standalone-workflow.ts` — `recoverStandaloneWorkflowRun` (resume an independent graph without a model).
- `control-recovery.ts` — `recoverTurnIntentControl` (replay the `describe_turn` interpretation from its original call).
- `workflow-invocations.ts` — `runWorkflowInvocation` (shared durable child invocation for Pi/HTTP/scheduler drivers); re-exports `resumeOriginalRunTask`.
- `workflow-resumption.ts` — `resumeOriginalRunTask` (resume the original graph after the new owner proves its lease).
- `authorized-checkpoint.ts` — `verifiedAuthorizationInput` (prove the original authorized outcome without re-executing).
- `serialization.ts` — `snapshotRuntimeValue`, `encodeRuntimeValue`, `runtimeRequestDigest`.
- `checkpoint.ts` — `encodeCheckpoint`, `decodeCheckpoint`, `hasRedactedCredentials`.
- `tool-result.ts` — `savedToolContent`, `savedToolMetadata` (preserve provider-facing result parts).
- `index.ts` — re-exports journal, retry-policy, serialization and recovery symbols.

## Constraints
- Snapshot runtime values synchronously before another listener mutates a Pi event; the journal is registered before any grounding/publishing subscriber.
- Redact `SECRET_FIELD` names, 6-digit codes and credential/Bearer/`sk-` text; `runtimeRequestDigest` hashes the *unredacted* original so distinct credentials never share an identity.
- Only the `ui` channel is public presentation; `raw` and `internal` channels stay internal (no raw thinking, no provider headers, no lease tokens).
- Recovery NEVER grants authorization and never repeats a committed bank write; a missing receipt means unknown, not success.
- Replay safety comes from the central tool catalog: reads are `read_only`, writes require an owner/digest-checked atomic receipt to be `idempotent`, otherwise `reconcile_only`.
- `decodeCheckpoint` requires the original provider mode/provider/model; a changed provider is rejected.
- Model-request identity (not a reused provider call ID alone) disambiguates calls, including after recovery.
- Every write path must call `journal.assertLeaseOwned(client)` on the transaction handle; a lost lease blocks subsequent events and effects.

## Design Decisions
- Original model input is immutable: compaction may project the request but the checkpoint retains the complete archive, and continuation preserves the original system context.
- Invocation retry attempts are claimed (CAS) before a read retry and settled with the exact result; unsafe writes without a receipt become `needs_reconciliation`.
- `recoverOwnedRun` only auto-recovers GREEN reads and receipts; gated/unauthorized reads stop at `waiting`.

## Known Issues
- `CONTEXT.md` for this node was previously empty; this file now documents the current state.

## Notes for Agents
- There is NO card-consumption / card-spend / card-purchase / card-payment / card-debit capability anywhere in `agent/durable` — no card tool, helper, function, type or scenario.
- The card tool set (`get_cards`, `set_card_limit`, `freeze_card`, `unfreeze_card`, `report_lost_card`, `replace_card`, `apply_virtual_card`) does not appear here at all.
- Keywords consume/consumption/spend/purchase/buy/pay/payment/debit/charge (and 消费/刷卡/扣款/支付/付款/购买/交易) have zero matches in this node.
- The only tools referenced here are generic examples: `get_balance`, `list_subscriptions`, `transfer_money`, `reserve_budget`, `submit_plan`, `describe_turn`.
- Financial semantics (amounts, limits, market values, spend analysis) live elsewhere — do not look for them here.

## Dependencies
- `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`.
- `@/lib/db/repositories/agentRun`, `@/lib/contracts/runtime`, `@/lib/contracts/tool-catalog`, `@/lib/errors`, `@/lib/ledger`.
- `@/agent/command-execution`, `@/security`, `@/agent/tools`, `@/agent/session`, `@/agent/banking-agent`, sibling `../confirmation/*` and `../turn-presentation`.

## Routing Table
- No child directories; this node is flat and fully self-contained.
- Cross-references (siblings/parents, not children): `../CONTEXT.md` (agent runtime), `../confirmation/` (gateway authorization + gated execution), `../tools/` (tool implementations and catalog), `../../security/` (permission/risk/verification), `../../lib/db/repositories/` (persistence used by these modules).
