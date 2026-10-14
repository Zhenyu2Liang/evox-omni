# Agent runtime context

The agent layer assembles Pi Core, provider adapters, user context, workflow ports and server-authored presentation. It does not grant banking permission.

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

`confirmation.ts` is the public decision facade. `confirmation/identity.ts` resolves persisted ownership;
`liveness.ts` owns decision leases; `outcomes.ts` projects refusals and convergence; `authorized-execution.ts`
lands authorized command evidence before narration. `gated-execution.ts` is the workflow execution port,
and `plan-continuation.ts` resumes downstream nodes without rewriting a committed business result.
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
