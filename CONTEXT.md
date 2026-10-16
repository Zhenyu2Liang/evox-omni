# Banking Agent repository context

## Purpose

A competition simulator for natural-language banking with server-controlled permission, inspectable workflows, exact financial values and durable execution evidence. The model proposes work; code grants or rejects it. No real banking rail is connected.

## Module boundaries

- `lib/contracts/tool-catalog.ts`: tool names, effects, tiers and replay metadata.
- `agent/durable/`: every observed Pi event, run lease, stable invocation, explicit retry/recovery.
- `agent/intent-context.ts` and `agent/tools/plan-compiler.ts`: user-authored context and pre-persistence request/condition/output validation.
- `planner/` and agent adapters: DAG transitions, persistent ownership and checkpoints.
- `security/`: permissions, cumulative risk, verification, incidents and locks.
- `agent/command-execution.ts`: mutation, mandatory audit, original receipt and invocation completion in one transaction.
- `banking-sdk/`: exact domain arithmetic and mutations through trusted execution context.
- `lib/db/unit-of-work.ts`: nested repository calls share the current transaction.
- `agent/financial-response.ts`: financial claims from structured evidence.
- `agent/manual-review.ts`: stop future work while preserving already-started command facts.
- `agent/scheduled-dispatcher.ts`: delivered reminders and freshly gated due payment workflows.

## Routing Table

- `tests/e2e/`: real-browser acceptance — `acceptance.e2e.ts` (mock model) and `live-acceptance.e2e.ts` (live model), plus `*.e2e-helper.ts` scenario modules.
- `tests/unit/`, `tests/scenarios/`, `tests/integration/`, `tests/app/`: pure, scenario, SQLite-backed and HTTP coverage.
- `tests/helpers/`, `tests/fixtures/`: shared scenario harness and seeded-fixture ids.

## Invariants

Booked amounts are Prisma `BigInt` minor units with explicit `*Minor` names. Annual yield ratios and unrounded valuations use Decimal arithmetic and canonical SQLite TEXT storage. `principalAmountMinor` is booked cash; `estimatedMarketValue` is unrounded CNY. Settlement rounds HALF_UP once to cents and records the quote and policy in the immutable result. Public monetary inputs and outputs are strings; `annualYieldRate` is a ratio in storage and DTOs, converted to a percentage only for display. Calculations and conditions never use floating-point money. Chart coordinate conversion is presentation only. Flagged consumption remains in booked totals. A budget envelope does not lock withdrawable cash. See `docs/cn/financial-values.md`.

Exceeding the MFA attempt limit is a terminal state: the gateway persists the command's `PendingAction` as `'locked'` (a CAS from `pending`/`awaiting_mfa`), so it stops surfacing as a pending decision and is never re-prompted; the client's popup dismisses and renders the locked failure. See `security/CONTEXT.md`.

Operation keys are server-owned invocation/action/node identities. Receipts match owner, tool and normalized arguments and replay original responses before mutable lookup. Transfers additionally match their ledger. Missing evidence does not prove failure. New writes require current authorization and in-transaction ownership fences.

Pi events are copied and persisted before transforms or effects. Only grounded UI events are public. Transport request IDs deduplicate run admission; session revision guards prevent overwrite. Old lease holders cannot append or write after replacement. Recovery verifies original evidence and resumes bounded original model requests or persisted workflow graphs. Incomplete model outputs cannot execute tools. See `docs/cn/agent-durability.md`.

Business calendar boundaries use UTC+08:00. Security expiry, leases and operational scheduling use real time. The authenticator and banking rail are explicit simulators.

The web demo has one server-configured user and a persistent `demo:${userId}` workspace, loaded on
page opening and shared by all browsers. There is no login, authentication cookie, workspace
selection, or old-session adoption. The language cookie stores only a presentation preference.
Action/task ownership, confirmation/MFA, receipts and execution leases still apply. Generic internal
sessions support runtime contracts and tests; they are not selectable web identities.

## Operation

Use pnpm for dependency management and all project commands. Commit only `pnpm-lock.yaml`; do not introduce npm or Yarn lockfiles. Only the current schema and contracts are supported; do not add old-schema migrations, numeric financial input adapters, or old receipt/API fallback paths. `pnpm db:push` synchronizes the current schema; `pnpm db:reset` recreates simulated data. Temporary artifacts stay in the repository. Test processes share one SQLite database and must not overlap.

File logs must be stored under `logs/`. Command output retained for reviews, tests, installs or builds must use that directory. Do not create `.log` files in the repository root. Keep ordinary terminal output visible unless a log capture is requested. Banking audit, event and receipt records remain in their existing database stores.

Documentation entry point: `docs/cn/README.md`. Development procedures live in `docs/cn/development.md`; current design lives in `docs/cn/architecture.md` and its linked topic guides. Write developer documentation in Chinese using the STC rules in `docs/cn/CONTEXT.md` and terms in `docs/cn/terms.md`. Keep the root README focused on the project overview, quick start, common commands and documentation links. Historical results remain in Git history and do not define current contracts.

## Known issue: fabricated confirmation-panel claim (LIVE mode)

A confirmation/MFA panel exists ONLY while a real `PendingAction` row does (`pending`/`awaiting_mfa`), created solely by a model tool call through `agent/banking-agent.ts` beforeToolCall -> `security/security-gateway.ts` handleToolCall -> gatewayCreatePendingAction. A prose-only reply that says "confirm in the panel above" creates nothing, so no panel appears. No code detects or repairs this claim today: `agent/reply-format.ts` inspects only protocol envelopes, and the declared-write check in `agent/tools/plan-compiler.ts` runs only inside `submit_plan`. See `agent/CONTEXT.md` "Known Issues" for the diagnosis and hook points; `tests/CONTEXT.md` records the coverage gap.
