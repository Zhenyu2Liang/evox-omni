# Agent runtime context

The agent layer assembles Pi Core, provider adapters, user context, workflow ports and server-authored presentation. It does not grant banking permission.

## Routing Table

- `./confirmation/`: confirm/verify/cancel decision facade internals, gateway outcome contracts, leases (incl. the `locked` MFA outcome behavior).
- `./durable/`: Pi event journal, run leases, workflow/standalone continuation and recovery.
- `./turns/`: turn contracts, event grounding/buffering, authorization views, bounded prompts.
- `./tools/`: banking tool implementations and the tool registry.
- `./providers/`: live + mock provider/model adapters.
- `./workflows/`: workflow cancellation.
- `./context-compaction/`: historical summaries and bounded model-request projection.
- `./messages/`: presentation message catalogs.

## Capability boundary: one card-spend write

The agent exposes exactly ONE card-spend write — `consume_virtual_card` (RED) — which pays a positive exact-CNY amount from an owned account-bound virtual card by debiting its linked checking account. There is no other card-consumption / card-spend / card-purchase / card-payment / card-debit capability.
`consume_virtual_card` books at SERVER business time: its schema carries no date or time argument, and a model-supplied time field is rejected with a `VALIDATION` error carrying `消费入账时间由服务端决定`, writing no funds, no ledger row and no `CardConsumption` row.
Its spendable amount is `min(account available cash, remaining monthly limit)`; a monthly limit of 0 blocks spending entirely, and a card with no monthly limit is bounded only by the linked account's cash.
A repeated `executionKey` replays the persisted consumption instead of charging the linked account again.
The card tool family otherwise reads and manages card records: `get_cards` (read), `set_card_limit` (per-category limit, no money movement), `freeze_card`, `unfreeze_card`, `report_lost_card`, `replace_card`, `apply_virtual_card`, plus the card-spend `consume_virtual_card` (see `tools/card.ts`, `card-emitter.ts`, `tools/index.ts`).
`analyze_spending`, `get_transactions` and `detect_anomaly` are GREEN reads over already-booked ledger rows; `detect_anomaly` never freezes a card.
A `CARD`-channel transaction row records a card charge but never identifies the owning debit/credit card from the deposit account type (see `system-prompt.ts:46`).
The other money-moving writes are `transfer_money`, `reserve_budget`, `subscribe_investment` and `redeem_investment`; `create_scheduled_task` with kind `PAYMENT` dispatches through the transfer channel, not a card or merchant billing integration.
Manual-only, on the Cards page with its own page verification, means exactly two things: creating a brand-new physical DEBIT/CREDIT card, and deleting a card record (`system-prompt.ts:38`).
The Cards page has no 补办 action.
`replace_card` (RED, `tools/card.ts:393-427`) is an ordinary agent capability for an owned `LOST` card of ANY type (DEBIT/CREDIT/VIRTUAL): the replacement inherits the source type and network, a CREDIT replacement inherits `creditLimitMinor`/`availableLimitMinor`, a VIRTUAL replacement keeps its linked settlement account and the month-continuous family allowance, the source card stays `LOST` with `replacedByCardId` set, and a repeat call returns that same replacement. No card-type gate exists in `agent/`, `lib/` or `security/`.
The server-authored manual-only reply is the guidance vocabulary `card_management_required` / `capabilities` in `messages/conversation.zh-CN.json:7-8`; it limits page-only scope to brand-new physical card creation and card cancellation, and never denies 补办 of an already-lost card or 申请虚拟卡. A live model may emit that envelope and the server renders it verbatim (`banking-guidance.ts:22-56`, `turns/buffer.ts:25-36`); because `write-continuation.ts` returns early on a guidance envelope, such a reply is final and cannot self-correct.
`write-continuation.ts` only rescues a DECLARED-but-unemitted write (`pendingDeclaredWrites`, live-only); `declaredWriteTools` selects every catalog entry with `effect: 'write'`, so a declared `replace_card` is covered exactly like any other write. A model that refuses without declaring the write is never corrected.

## Public entry points

`agent/index.ts` exposes turns, confirmation/verification/cancellation, task controls, manual handoff and scheduled dispatch. App routes use the server-configured demo user and persistent `demo:${userId}` workspace before calling it. The web demo has no login or authentication cookie. Generic internal sessions remain available for runtime tests and bank ownership contracts; they cannot be selected through the web API. Tests can inject a `ModelRuntime` through `RunTurnDeps.provider` while exercising the real runtime and bank.

## Execution contracts

`turn-runtime.ts` admits a stable request and owns its session run lease. The first awaited subscriber is `AgentRunJournal`. It snapshots and records every original Pi event, and creates the invocation with the tool-start event before preflight. Grounded UI events are immutable and persisted before SSE publication. JSON responses replay the same saved snapshots.

`run-turn.ts` owns input orchestration; `authorization-resume.ts` injects an original authorized outcome. `turns/` separates contracts, buffers, event grounding, parked authorization views and bounded prompts. Internal presentation modules do not import entry points or recovery drivers.

Authorization result narration is server-authored in both mock and live modes. The original tool
result is replaced inside its contiguous result group while preserving all later dialogue. A missing
provider call cannot create an orphan tool result or hide an outcome already proven by its receipt.
Authorized workflow progress remains the executor's responsibility, not another model narration turn.

`durable/continuation.ts` resumes model checkpoints and verifies original context and execution facts. `durable/standalone-workflow.ts` resumes independent graphs without a model. `recovery-worker.ts` supplies bounded discovery and lease-protected recovery. Model partials are journal evidence only; changing the model contract, losing ownership or encountering uncertain effects cannot silently create a replacement operation.

`banking-agent.ts` installs the code-controlled gateway and supplies trusted user/session identities.
`beforeToolCall` is the ONLY consumer of `requiresDeclaredPlan` (`intent-context.ts:43`): with a declared multi-write or `workflow` intent it blocks individual write calls and preflights `submit_plan` (`banking-agent.ts:286-298`). At turn end `write-continuation.ts` reconciles a declared-but-unemitted write: `continueDeclaredWrites` issues exactly ONE bounded, restart-safe continuation (its `WriteContinuationState` budget is persisted before the provider call) — only when the candidate reply is ordinary prose, since a protocol envelope needing format repair or a valid `guidance` envelope stays on its own path — and if no controlled call appears the server still publishes its authoritative `declared_unsubmitted` state (`renderFinancialResponse(buffer.factResults, { declared })`) instead of prose that could claim a panel. The declared-vs-emitted comparison reads `runtime.serialize().intent` and is live-only (`config.llmMode === 'live'`); a real gate is still produced only by a blocked gateway call.
`intent-context.ts` starts a new undecided intent per user turn and stores the structured describe_turn
declaration. `tools/plan-compiler.ts` validates declared write counts/order and explicit structured
parameters, dates, conditions and output references before createTaskGraph persists the whole DAG.
Production does not extract arguments or dependencies from the original user sentence.

Preflight refusals remain model-facing corrections in `planningRejections` and Pi tool results.
`turns/events.ts` projects them through `lib/tool-feedback.ts` into catalog-owned public summaries
and a separate `ToolEventView.debugDetail`. Do not copy provider correction instructions into
ordinary user-facing summaries or error cards. Recorded diagnostics remain available to the
developer view; this presentation change does not alter checkpoint identities or permission gates.

Every registered write enters `command-execution.ts`. Operation identity belongs to the server invocation, action or node. The command's mutation, strict audit, original response and invocation completion share one transaction. Receipts are replayed before mutable lookup; transfers additionally match their ledger. Unknown outcomes stop for reconciliation.

## 投资写入能力

`subscribe_investment` 与 `redeem_investment` 都是 RED 写入，经同一网关授权、逐次强验证与执行围栏，操作身份由服务器拥有的调用/动作/节点决定。对已持有产品的再次申购由 SDK 聚合进现有持仓（`InvestResult.addedToExisting = true`），不新建持仓。赎回本金金额是可选参数 `redeemAmount`（精确 CNY 十进制字符串）：省略或等于持仓本金表示全额赎回（持仓结清）；严格更小的正数表示部分赎回（持仓保留、本金减少，仅按同一估值规则结算该部分本金，剩余本金与市值留在持仓上）。金额绝不使用浮点，计算使用整数最小单位或十进制算术。系统提示与 `redeem_investment` 工具描述均已声明支持部分赎回。工具层细节见 `./tools/CONTEXT.md`。

`confirmation.ts` is the public decision facade. `confirmation/identity.ts` resolves persisted ownership;
`confirmation/liveness.ts` owns decision leases; `confirmation/outcomes.ts` projects refusals and convergence; `confirmation/authorized-execution.ts`
lands authorized command evidence before narration. `confirmation/gated-execution.ts` is the workflow execution port,
and `confirmation/plan-continuation.ts` resumes downstream nodes without rewriting a committed business result.
`confirmation-recovery.ts` lands action states and receipts without inventing effects. Workflow
generation/token and session policy fences remain in the actual banking transaction. Manual handoff
preserves current in-flight work and stops the next checkpoint. Scheduled dispatch reuses a persistent
workflow and current approval.

## Presentation

Developer chat reset clears the current transcript, model messages and intent only after the session
revision/write fence and unfinished-work checks succeed. The fixed session identity, bank data,
authorization evidence and immutable runtime history remain. `SessionSnapshot.historyStartedAt`
selects current-history plans after reset; ordinary refresh never changes this boundary.

Tool execution can begin after the provider assistant message ends. Each call has an independent
tool-role message and owned result/authorization cards; complete prose before or after it has its
own assistant message. Completion and authorization continuation update the original tool entry.
Durable run/model-request identities disambiguate reused provider call IDs, including after recovery.
`transcript-activity.ts` reconciles page history from scoped invocation/action evidence.
`transcript-presentation.ts` separates existing mixed UI entries without changing original prose,
financial records or the immutable model/event archive. See `turns/CONTEXT.md` for event ownership.

`grounding-facts.ts` projects exact structured account/write facts. `financial-response.ts` renders authoritative financial statements. Planning text, model-generated correction tags and prose are never execution evidence. Public APIs expose grounded events and safe metadata; raw thinking remains internal.

Card results — the card reads, the card mutations and `consume_virtual_card` — render as a `cards` card built from the server-returned card projection (`card-emitter.ts`), which carries the linked account, its available balance, the monthly limit and the currently payable amount; model prose never fills a result card.

The registered internal describe_turn tool declares purpose, ordered requested capabilities and
optional workflow/example flags for one current user turn. Its result is interpretation, never
authorization. Ordinary explanation permits automatic GREEN reads but cannot open a gated read or
write authorization. Advice allows relevant authorized queries and refuses writes. Repeated write
declarations require a complete workflow. Production never infers these purposes from user wording.
GREEN lookups may identify targets before declaration. An operation preparation declaration may
contain only prerequisite reads; after their results, the complete write sequence is bound once.
Purpose never changes, and a declaration containing writes cannot be expanded or replaced.
Natural-language routing exists only inside providers/mock as a deterministic offline model script.

`conversation-context.ts` restores missing user wording from the server-saved transcript.
`context-compaction/projection.ts` replaces only a validated summarized prefix in the model request
view; the complete archive and contiguous tool groups remain intact. Historical requests never
provide current consent or replace the new turn's declaration. New-turn restoration uses the saved transcript,
matching ordered user occurrences and inserting at surviving user boundaries. Restoration adds no
assistant facts, tool chains or authorization, and cannot split a contiguous assistant/result group.
Recorded model-request continuation bypasses both context adjustments.

`guidance-messages.ts` is a closed presentation vocabulary without request parsing. The mock-only
conversation-guidance/policy/advisory/amount modules may script local demonstrations; production
business validation checks structured arguments through the same gateway and SDK used by live Pi.
`conversation-evidence.ts` collects prior structured query/write outcomes for dated discussion.
`conversational-response.ts` preserves model prose verbatim. It never infers intent, personal balance,
execution success or draft revival from wording. Actual financial outcomes are typed tool entries,
authorization states and execution receipts. `reply-format.ts` recognizes complete protocol envelopes
through JSON parsing and closed structure checks, rather than field words or embedded Markdown
examples. Explicit typed allowProtocolExamples permits protocol teaching examples. A format-only
repair has a persisted one-request budget and retains raw original and corrected responses. Retiring
an unpublished candidate removes only its assistant events; independent tool/result rows remain.
`turn-presentation.ts` keeps ordinary prose separate from server-authored financial result rendering;
financial success still requires actual execution evidence. A question about transfer funding is not
an instruction to execute the previous transfer draft or retry an unfinished plan.

Pi 1.2 derives its system context and tool set from transcript system messages. New input and authorization turns
remove prior system messages before constructing the current prompt and declarations, while retaining
user, assistant and tool history. Durable continuation with a recorded model request preserves its
checkpoint system context and original request, rather than applying a new turn's prompt retroactively.

`context-compaction/` persists historical summaries, pending summary requests and complete-turn cuts.
Pi request preparation and context transformation use the same bounded projection. Session and run
checkpoints retain the complete archive; the model request record retains the actual projection.
Summary calls have their own event stream and cannot execute banking tools. Recovery reuses an
unfinished summary input or the immutable original normal model input. Exact old wording is available
through the owner-bound GREEN `search_conversation_history` capability.

Authorization results update the original tool group in place. Mutation receipts remain server-authored
and do not invoke another model turn. A still-current query/advice question can continue model analysis,
and an operation preparation can propose its remaining declared work after a confirmed read,
using its saved purpose and original question. Every new write still needs gateway authorization. Later user messages
disable that automatic continuation. `authorization-context.ts` locates the
original assistant through the owned action, invocation and model request, so reused provider call IDs
cannot redirect an older committed result into a newer operation.

Use the central tool catalog and financial string contracts. See `docs/cn/architecture.md`, `docs/cn/agent-durability.md` and `docs/cn/security.md` for current behavior and limits.
