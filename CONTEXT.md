# Banking Agent repository context

## Purpose

A competition simulator for natural-language banking with server-controlled permission, inspectable workflows, exact financial values and durable execution evidence. The model proposes work; code grants or rejects it. No real banking rail is connected.

## Module boundaries

- `lib/contracts/tool-catalog.ts`: tool names, effects, tiers and replay metadata.
- `channels/weixin/`: pi-weixinbot protocol transport, QR-owner binding, durable reply outbox, public business-card projection and explicit action/workflow/schedule commands through the existing local banking HTTP API. See `docs/cn/weixin.md`.
- `agent/durable/`: every observed Pi event, run lease, stable invocation, explicit retry/recovery.
- `agent/intent-context.ts` and `agent/tools/plan-compiler.ts`: user-authored context and pre-persistence request/condition/output validation.
- `planner/` and agent adapters: DAG transitions, persistent ownership and checkpoints.
- `security/`: permissions, cumulative risk, verification, incidents and locks.
- `agent/command-execution.ts`: mutation, mandatory audit, original receipt and invocation completion in one transaction.
- `banking-sdk/`: exact domain arithmetic and mutations through trusted execution context.
- `lib/db/unit-of-work.ts`: nested repository calls share the current transaction.
- `agent/financial-response.ts`: financial claims from structured evidence.
- `agent/write-continuation.ts`: bounded, restart-safe continuation when a declared write produced no controlled tool call.
- `agent/manual-review.ts`: stop future work while preserving already-started command facts.
- `agent/scheduled-dispatcher.ts`: delivered reminders and freshly gated due payment workflows.
- `banking-sdk/card.ts`, `agent/tools/card.ts`, `app/api/cards/[id]/consume/`: a VIRTUAL card is a debit instrument bound to one owned CHECKING account; `consume_virtual_card` debits that account and writes a `CardConsumption` row in one transaction, guarded by the card's monthly limit and replayable by execution key.

## Routing Table

- `tests/e2e/`: real-browser acceptance — `acceptance.e2e.ts` (mock model) and `live-acceptance.e2e.ts` (live model), plus `*.e2e-helper.ts` scenario modules.
- `tests/unit/`, `tests/scenarios/`, `tests/integration/`, `tests/app/`: pure, scenario, SQLite-backed and HTTP coverage.
- `tests/helpers/`, `tests/fixtures/`: shared scenario harness and seeded-fixture ids.

- `banking-sdk/`: exact domain arithmetic & mutations — `card.ts`, `account.ts`, `transaction.ts`, `transfer.ts`, `investment.ts`, `types.ts`, `index.ts`.
- `agent/`: Pi runtime & banking tools — `tools/` (registry + family modules), `confirmation/`, `durable/`, `turns/`, `providers/`, `workflows/`.
- `lib/`: shared contracts & data access — `contracts/tool-catalog.ts` (capability source of truth), `db/` + `db/repositories/`, `i18n/` message catalogs.
- `app/`: Next.js pages (`cards/`, `overview/`, ...) & HTTP edge (`api/` routes).
- `components/`: display components — `components/banking/` (`CardTile` etc.), `components/chat/cards/` (chat result cards).
- `security/`: permissions, gateway, manual card management, verification, locks. `planner/`: DAG transitions & workflow ownership.
- `prisma/`: schema & demo seed. `scripts/`: CLI command entry points. `docs/cn/`: developer documentation.

## Invariants

Booked amounts are Prisma `BigInt` minor units with explicit `*Minor` names. Annual yield ratios and unrounded valuations use Decimal arithmetic and canonical SQLite TEXT storage. `principalAmountMinor` is booked cash; `estimatedMarketValue` is unrounded CNY. Settlement rounds HALF_UP once to cents and records the quote and policy in the immutable result. Public monetary inputs and outputs are strings; `annualYieldRate` is a ratio in storage and DTOs, converted to a percentage only for display. Calculations and conditions never use floating-point money. Chart coordinate conversion is presentation only. Flagged consumption remains in booked totals. A budget envelope does not lock withdrawable cash. See `docs/cn/financial-values.md`.

A VIRTUAL card is a debit instrument bound to one owned CHECKING account: it draws on that account's cash and its own monthly consumption limit, so its spendable amount is `min(account available cash, remaining monthly limit)` and its balance is account cash, never credit. Multiple virtual cards on one account share that single balance, which is counted once in total assets. A card replaced via loss/补办 is terminal (`LOST`) and must not be counted alongside its replacement — the credit-available total sums only `CREDIT` cards that are not `LOST`.

Exceeding the MFA attempt limit is a terminal state: the gateway persists the command's `PendingAction` as `'locked'` (a CAS from `pending`/`awaiting_mfa`), so it stops surfacing as a pending decision and is never re-prompted; the client's popup dismisses and renders the locked failure. See `security/CONTEXT.md`.

The breaker lock is OWNER-scoped (`user:<userId>` via `security/circuit-breaker.ts#resolveBreakerOwner`), never per action. `security/mfa.ts#verify` therefore reports `locked: true` for a DIFFERENT operation whose challenge had zero attempts (`attemptsLeft = maxAttempts - attempts`), and `security/security-gateway.ts#authorizeWithMfa` unconditionally maps `locked` to `failure.reason: 'mfa_attempts_exhausted'` with `attemptsUsed = MFA_MAX_ATTEMPTS - attemptsLeft` — 0 (or negative) in that case — and CASes that other row to `'locked'` too. The account-level gate before MFA and the re-attempt on a locked row both use `reason: 'circuit_open'` / `'mfa_session_locked'` with `failure.code: 'CIRCUIT_OPEN'` instead. Remaining-attempt copy renders from `lib/public-text.ts#securityNotice`; its single `?? 0` is the only default, so a `failure` lacking `attemptsLeft` renders "0 attempts left" and a negative value renders as-is.

Operation keys are server-owned invocation/action/node identities. Receipts match owner, tool and normalized arguments and replay original responses before mutable lookup. Transfers additionally match their ledger. Missing evidence does not prove failure. New writes require current authorization and in-transaction ownership fences.

Pi events are copied and persisted before transforms or effects. Only grounded UI events are public. Transport request IDs deduplicate run admission; session revision guards prevent overwrite. Old lease holders cannot append or write after replacement. Recovery verifies original evidence and resumes bounded original model requests or persisted workflow graphs. Incomplete model outputs cannot execute tools. See `docs/cn/agent-durability.md`.

A confirmation/MFA panel exists ONLY while a real `PendingAction` row does (`pending`/`awaiting_mfa`), created solely by a model tool call through `agent/banking-agent.ts` beforeToolCall → `security/security-gateway.ts` handleToolCall → gatewayCreatePendingAction. Model prose creates no panel. When a turn declares a banking write (`describe_turn`) but emits no controlled tool call, the runtime spends at most ONE bounded continuation (`agent/write-continuation.ts`) and, if the write still stays unsubmitted, the server — never the model — narrates the true unsubmitted state. See `agent/CONTEXT.md` and `tests/CONTEXT.md`.

Business calendar boundaries use UTC+08:00. Security expiry, leases and operational scheduling use real time. The authenticator and banking rail are explicit simulators.

The web demo has one server-configured user and a persistent `demo:${userId}` workspace, loaded on
page opening and shared by all browsers. There is no login, authentication cookie, workspace
selection, or old-session adoption. The language cookie stores only a presentation preference.
Action/task ownership, confirmation/MFA, receipts and execution leases still apply. Generic internal
sessions support runtime contracts and tests; they are not selectable web identities.

## Operation

Use pnpm for dependency management and all project commands. Commit only `pnpm-lock.yaml`; do not introduce npm or Yarn lockfiles. Only the current schema and contracts are supported; do not add old-schema migrations, numeric financial input adapters, or old receipt/API fallback paths. `pnpm db:push` synchronizes the current schema; `pnpm db:reset` recreates simulated data. Temporary artifacts stay in the repository. Test processes share one SQLite database and must not overlap. Prisma commands run offline only with `CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 CI=1` set, otherwise `pnpm db:generate` can hang. The root `vitest.config.ts` collects `*.test.ts` under `tests/**`, `agent/**`, `security/**` and `planner/**`.

File logs must be stored under `logs/`. Command output retained for reviews, tests, installs or builds must use that directory. Do not create `.log` files in the repository root. Keep ordinary terminal output visible unless a log capture is requested. Banking audit, event and receipt records remain in their existing database stores.

Documentation entry point: `docs/cn/README.md`. Development procedures live in `docs/cn/development.md`; current design lives in `docs/cn/architecture.md` and its linked topic guides. Write developer documentation in Chinese using the STC rules in `docs/cn/CONTEXT.md` and terms in `docs/cn/terms.md`. Keep the root README focused on the project overview, quick start, common commands and documentation links. Historical results remain in Git history and do not define current contracts.
