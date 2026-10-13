# Agent runtime context

The agent layer assembles Pi Core, provider adapters, user context, workflow ports and server-authored presentation. It does not grant banking permission.

## Public entry points

`agent/index.ts` exposes turns, confirmation/verification/cancellation, task controls, manual handoff and scheduled dispatch. App routes resolve cookie-owned identity before calling it. Tests can inject a `ModelRuntime` through `RunTurnDeps.provider` while exercising the real runtime and bank.

## Execution contracts

`turn-runtime.ts` admits a stable request and owns its session run lease. The first awaited subscriber is `AgentRunJournal`. It snapshots and records every original Pi event, and creates the invocation with the tool-start event before preflight. Grounded UI events are immutable and persisted before SSE publication. JSON responses replay the same saved snapshots.

`run-turn.ts` owns input orchestration; `authorization-resume.ts` injects an original authorized outcome. `turns/` separates contracts, buffers, event grounding, parked authorization views and bounded prompts. Internal presentation modules do not import entry points or recovery drivers.

`durable/continuation.ts` resumes model checkpoints and verifies original context and execution facts. `durable/standalone-workflow.ts` resumes independent graphs without a model. `recovery-worker.ts` supplies bounded discovery and lease-protected recovery. Model partials are journal evidence only; changing the model contract, losing ownership or encountering uncertain effects cannot silently create a replacement operation.

`banking-agent.ts` installs the code-controlled gateway and supplies trusted user/session identities. `intent-context.ts` maintains user-authored references and intent steps across turns. `tools/plan-compiler.ts` validates requested entities, exact amounts, dates, conditions and typed output references before `createTaskGraph` persists the whole DAG.

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

`grounding-facts.ts` projects exact structured account/write facts. `financial-response.ts` renders authoritative financial statements. Planning text, model-generated correction tags and prose are never execution evidence. Public APIs expose grounded events and safe metadata; raw thinking remains internal.

Use the central tool catalog and financial string contracts. See `docs/architecture.md`, `docs/agent-durability.md` and `docs/security.md` for current behavior and limits.
