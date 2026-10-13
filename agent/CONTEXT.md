# Agent runtime context

The agent layer assembles Pi Core, provider adapters, user context, workflow ports and server-authored presentation. It does not grant banking permission.

## Public entry points

`agent/index.ts` exposes turns, confirmation/verification/cancellation, task controls, manual handoff and scheduled dispatch. App routes resolve cookie-owned identity before calling it. Tests can inject a `ModelRuntime` through `RunTurnDeps.provider` while exercising the real runtime and bank.

## Execution contracts

`turn-runtime.ts` admits a stable request and owns its session run lease. The first awaited subscriber is `AgentRunJournal`. It snapshots and records every original Pi event, and creates the invocation with the tool-start event before preflight. Grounded UI events are immutable and persisted before SSE publication. JSON responses replay the same saved snapshots.

`banking-agent.ts` installs the code-controlled gateway and supplies trusted user/session identities. `intent-context.ts` maintains user-authored references and intent steps across turns. `tools/plan-compiler.ts` validates requested entities, exact amounts, dates, conditions and typed output references before `createTaskGraph` persists the whole DAG.

Every registered write enters `command-execution.ts`. Operation identity belongs to the server invocation, action or node. The command's mutation, strict audit, original response and invocation completion share one transaction. Receipts are replayed before mutable lookup; transfers additionally match their ledger. Unknown outcomes stop for reconciliation.

`confirmation.ts` coordinates authorized effects and workflow continuation. `confirmation-recovery.ts` lands action states and receipts without inventing effects. Workflow generation/token and session policy fences remain in the actual banking transaction. Manual handoff preserves current in-flight work and stops the next checkpoint. Scheduled dispatch reuses a persistent workflow and current approval.

## Presentation

`grounding-facts.ts` projects exact structured account/write facts. `financial-response.ts` renders authoritative financial statements. Planning text, model-generated correction tags and prose are never execution evidence. Public APIs expose grounded events and safe metadata; raw thinking remains internal.

Use the central tool catalog and financial string contracts. See `docs/architecture.md`, `docs/agent-durability.md` and `docs/security.md` for current behavior and limits.
