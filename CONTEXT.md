# Banking Agent repository context

## Purpose

A competition simulator for natural-language banking with server-controlled permission, inspectable workflows, exact financial values and durable execution evidence. The model proposes work; code grants or rejects it. No real banking rail is connected.

## Module boundaries

- `lib/contracts/tool-catalog.ts`: tool names, effects, tiers and replay metadata.
- `channels/weixin/`: pi-weixinbot protocol transport, QR-owner binding, durable reply outbox, public business-card projection and explicit action/workflow/schedule commands through the existing local banking HTTP API. See `docs/cn/weixin.md`.
- `agent/durable/`: every observed Pi event, run lease, stable invocation, explicit retry/recovery.
- `agent/intent-context.ts`, `agent/tools/plan-compiler.ts`, `agent/tools/plan-parameters.ts`: user-authored context, pre-persistence plan/condition/output validation and tool-schema argument validation before any effect.
- `planner/` and agent adapters: DAG transitions, persistent ownership and checkpoints.
- `security/`: permissions, cumulative risk, verification, incidents and locks.
- `agent/command-execution.ts`: mutation, mandatory audit, original receipt and invocation completion in one transaction.
- `banking-sdk/`: exact domain arithmetic and mutations through trusted execution context.
- `banking-sdk/net-value.ts`: BigInt fixed-point net value and share conversions — 4 dp net value, 6 dp shares, unrounded valuation, one HALF_UP settlement to cents.
- `components/banking/HoldingFacts.tsx`: the single render source for a holding's net value and share facts (`card` and `tile` layouts).
- `lib/db/unit-of-work.ts`: nested repository calls share the current transaction.
- `lib/phone.ts`, `security/recipient-resolution.ts`, `security/card-resolution.ts`: identity matches only complete numbers or exact owned ids (`Contact.phoneFull`/`Card.numberFull` stay authoritative, though a display column may hold one); masks and tails only narrow candidates, never identity, and every outward projection is masked. See `docs/cn/identity-resolution.md`.
- `agent/financial-response.ts`: financial claims from structured evidence.
- `agent/write-continuation.ts`: bounded, restart-safe continuation when a declared write produced no controlled tool call.
- `agent/manual-review.ts`: stop future work while preserving already-started command facts.
- `agent/scheduled-dispatcher.ts`: delivered reminders and freshly gated due payment workflows.
- `prisma/schema.prisma`, `banking-sdk/card.ts`: `Card.linkedAccountId` is a real foreign key to `Account.id`; every DEBIT/VIRTUAL card projects its settlement account as `CardView.linkedAccountStatus` (`LINKED`/`MISSING`/`UNTRUSTED`/`NOT_APPLICABLE`) plus `usable`. See `docs/cn/card-management.md`.
- `banking-sdk/card.ts`, `agent/tools/card.ts`, `app/api/cards/[id]/consume/`: `consume_virtual_card` debits the card's bound CHECKING account and writes a `CardConsumption` row in one transaction, guarded by the card's monthly limit (spend summed across the 补办 family), on a server-owned consumption instant, and replayable by execution key.

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

Booked amounts are Prisma `BigInt` minor units with explicit `*Minor` names. Annual yield ratios and unrounded valuations use Decimal arithmetic and canonical SQLite TEXT storage. Settlement rounds HALF_UP once to cents and records the quote and policy in the immutable result. Public monetary inputs and outputs are strings; `annualYieldRate` is a ratio in storage and DTOs, converted to a percentage only for display. Calculations and conditions never use floating-point money. Chart coordinate conversion is presentation only. Flagged consumption remains in booked totals. A budget envelope does not lock withdrawable cash. See `docs/cn/financial-values.md`.

An investment holding is accounted by net value and shares: `marketValue = shares × latestNetValuePerUnit` (unrounded), `principalAmountMinor` is the remaining cost basis, holding profit is unrealized, cumulative profit is realized plus unrealized, and an additional purchase never counts as profit. Reads derive the market value from shares and the latest net value — a holding with no usable shares or no published net value reports its remaining cost and no profit; `estimatedMarketValue` is only a column snapshot and is never read for valuation. A redemption must state an explicit server-side mode (`SHARES`/`AMOUNT`/`ALL`), enforced by the tool schema, the security gateway and the plan validator; a missing, unknown or mixed mode (or the retired `redeemAmount`) is a clarification, never a default. A confirmation snapshot (`expectedShares`, `expectedNetValue`, `expectedNetValueDate`, `expectedSettlementAmount`) that no longer matches fails the command with `CONFLICT`, writes nothing and requires a fresh confirmation; a same-identity replay still returns the original receipt. Net value keeps 4 decimals and shares 6. A holding's return rate is a signed ratio rendered through `lib/decimal.ts#signedRateToPercent`, which never clamps — only booked amounts and the non-negative `annualYieldRate` pass the nonnegative gate. An investment write (`subscribe_investment`/`redeem_investment`) projects the holdings it just produced: the chat investments card after a write carries a post-commit re-read of the position, never a pre-write snapshot. See `docs/cn/investments.md`.

A VIRTUAL card is a debit instrument bound to one owned CHECKING account: it draws on that account's cash and its own monthly consumption limit, so its spendable amount is `min(account available cash, remaining monthly limit)` and its balance is that account's cash, never credit; only a `LINKED` binding carries the account name, masked number and balances. Multiple virtual cards on one account share that single balance, which is counted once in total assets. A card replaced via loss/补办 is terminal (`LOST`) and must not be counted alongside its replacement — the credit-available total sums only `CREDIT` cards that are not `LOST`. A DEBIT or VIRTUAL card never holds a balance of its own: `MISSING`/`UNTRUSTED` bindings omit every balance field instead of reporting zero, while `FROZEN`/`LOST` keep the real account balance with `usable === false`.

Exceeding the MFA attempt limit is a terminal state: the gateway persists the command's `PendingAction` as `'locked'` (a CAS from `pending`/`awaiting_mfa`), so it stops surfacing as a pending decision, is never re-prompted, re-verified, cancelled or recovered, and an audited unlock clears the breaker without reviving the row; the client's popup dismisses and renders the locked failure. See `security/CONTEXT.md`.

The breaker lock is OWNER-scoped (`user:<userId>` via `security/circuit-breaker.ts#resolveBreakerOwner`), never per action, so `security/mfa.ts#verify` also reports `locked: true` for a DIFFERENT operation of a locked account. The reason is then decided by that operation's OWN attempt record (`security/mfa.ts#attemptState`): `security/security-gateway.ts#authorizeWithMfa` answers a top-level `CIRCUIT_OPEN` either way and differentiates by the failure: `MFA_LOCKED`/`mfa_attempts_exhausted` only when the operation exhausted its own attempts, `CIRCUIT_OPEN`/`circuit_open` when the account breaker tripped elsewhere, with `attemptsUsed` taken from that record, and both branches CAS the row to `'locked'`. The gate before MFA (`circuit_open`) and the re-attempt on a locked row (`mfa_session_locked`) also return `failure.code: 'CIRCUIT_OPEN'`. Internal markers (`__SECURITY_BLOCK__` payloads, JSON fragments, stack frames) never reach public text: `lib/internal-text.ts#isInternalDiagnostic` is the single predicate and `lib/public-text.ts` the single funnel. Remaining-attempt copy renders only through `lib/public-text.ts#securityNotice`, whose single `?? 0` is the only default, so a `failure` lacking `attemptsLeft` renders "0 attempts left" and a negative value renders as-is.

Operation keys are server-owned invocation/action/node identities. Receipts match owner, tool and normalized arguments and replay original responses before mutable lookup. Transfers additionally match their ledger. Missing evidence does not prove failure. New writes require current authorization and in-transaction ownership fences.

Pi events are copied and persisted before transforms or effects. Only grounded UI events are public. Transport request IDs deduplicate run admission; session revision guards prevent overwrite. Old lease holders cannot append or write after replacement. Recovery verifies original evidence and resumes bounded original model requests or persisted workflow graphs. Incomplete model outputs cannot execute tools. See `docs/cn/agent-durability.md`.

A confirmation/MFA panel exists ONLY while a real `PendingAction` row does (`pending`/`awaiting_mfa`), created solely by a model tool call through `agent/banking-agent.ts` beforeToolCall → `security/security-gateway.ts` handleToolCall → gatewayCreatePendingAction. Model prose creates no panel. When a turn declares a banking write (`describe_turn`) but emits no controlled tool call, the runtime spends at most ONE bounded continuation (`agent/write-continuation.ts`) and, if the write still stays unsubmitted, the server — never the model — narrates the true unsubmitted state. An open manual review does not cancel a parked command: confirm/verify return a domain refusal whose `code` is `MANUAL_REVIEW_HOLD` and whose `failure.reason` is `'manual_review_hold'`, rendered only as `chat.error.manualReviewHold` (the operation was not executed — resume it from the review inbox or wait for the review to end); the generic state-changed copy is wrong there because refreshing changes nothing. The hold gates a new authorization, not the owner's withdrawal of one: `cancel` of an unsettled parked command still settles the row as `cancelled`. See `agent/CONTEXT.md` and `tests/CONTEXT.md`.

Business calendar boundaries use UTC+08:00. Security expiry, leases and operational scheduling use real time. The authenticator and banking rail are explicit simulators.

The web demo has one server-configured user and a persistent `demo:${userId}` workspace, loaded on
page opening and shared by all browsers. There is no login, authentication cookie, workspace
selection, or old-session adoption. The language cookie stores only a presentation preference.
Action/task ownership, confirmation/MFA, receipts and execution leases still apply. Generic internal
sessions support runtime contracts and tests; they are not selectable web identities.

## Operation

Use pnpm for dependency management and all project commands. Commit only `pnpm-lock.yaml`; do not introduce npm or Yarn lockfiles. Only the current schema and contracts are supported; do not add old-schema migrations, numeric financial input adapters, or old receipt/API fallback paths. `pnpm db:push` synchronizes the current schema; `pnpm db:reset` recreates simulated data. Temporary artifacts stay in the repository. Test processes share one SQLite database and must not overlap. Prisma commands run offline only with `CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 CI=1` set, otherwise `pnpm db:generate` can hang. The root `vitest.config.ts` collects `*.test.ts` under `tests/**`, `agent/**`, `security/**` and `planner/**`.

File logs must be stored under `logs/`. Command output retained for reviews, tests, installs or builds must use that directory. Do not create `.log` files in the repository root. Keep ordinary terminal output visible unless a log capture is requested. Banking audit, event and receipt records remain in their existing database stores.

The root `.gitattributes` forces LF checkout for `*.patch` because pnpm patches must apply byte-exactly; a CRLF checkout (the Windows `core.autocrlf=true` default) makes `pnpm install` fail with `ERR_PNPM_INVALID_PATCH`. Chat-driven integration specs declare an explicit per-test budget from `tests/helpers/timeouts.ts` instead of a bare literal, because their wall time scales with per-statement SQLite latency and the global `vitest.config.ts` timeout is the only internal bound; see `tests/CONTEXT.md`.

Documentation entry point: `docs/cn/README.md`. Development procedures live in `docs/cn/development.md`; current design lives in `docs/cn/architecture.md` and its linked topic guides. Write developer documentation in Chinese using the STC rules in `docs/cn/CONTEXT.md` and terms in `docs/cn/terms.md`. Keep the root README focused on the project overview, quick start, common commands and documentation links. Historical results remain in Git history and do not define current contracts.
