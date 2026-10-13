# Testing and acceptance

The test suite checks the banking simulator through unit, scenario, route-handler, cross-module and real-browser layers. Vitest runs with `LLM_MODE=mock`; tests of the live execution path script only model transport while retaining the project's Pi runtime, tools, security checks and database execution. These tests verify application behavior independently of a model provider's availability.

For the development environment and configuration, see [Development](development.md). For implementation guarantees and their limits, see [Security](security.md), [Agent durability](agent-durability.md) and [Known risks](known-risks.md).

## Commands and isolation

```sh
pnpm test
pnpm test tests/unit
pnpm test tests/scenarios
pnpm test tests/app tests/integration
pnpm test agent/durable tests/integration/agent-durability.test.ts
pnpm typecheck
pnpm lint
pnpm exec tsx tests/e2e/acceptance.e2e.ts
```

`pnpm test` uses `vitest.config.ts`, which collects tests under `tests/` and `agent/`. Browser acceptance has a separate entry point and is not collected by Vitest. Read each command's output for the current passed, failed and skipped totals; this guide does not maintain a duplicated suite count.

Vitest provisions `prisma/test.db`; browser acceptance provisions `prisma/e2e.db`. Both override `DATABASE_URL` with the isolated database before application code runs, generate a usable Prisma Client and create the current schema. Database-backed suites seed their own fixtures. Provisioning pins Prisma schema-engine logging and preserves diagnostics on failure.

Vitest files run sequentially because they share a resettable test database. Run browser acceptance separately from Vitest and from development/build processes that share Next.js generated artifacts. Database setup failures must be diagnosed in the isolated test database rather than resolved by resetting the development database.

Browser acceptance uses `playwright-core` with installed system Chrome; Edge is a detection fallback. `E2E_BROWSER_PATH` can select an executable. The harness selects a free port, starts the actual Next.js development server and tears down its process tree when finished. Its database provisioning is automatic; a manual development database reset is unnecessary. Details are in [Browser harness context](../tests/e2e/CONTEXT.md).

Production build validation is separate: prepare a database with the current schema before `pnpm build`, because prerendered routes query it. Follow the database commands in [Development](development.md). There is no test step for converting an old database.

## Test layers

| Location | Responsibility |
| --- | --- |
| `tests/unit/` | Domain validation, SDK transactions, authorization, DAG execution, API/UI contracts and persistence helpers |
| `agent/**/*.test.ts` | Durable runtime, provider transport and server-authored financial response behavior |
| `tests/scenarios/` | End-to-end agent scenarios with controlled model responses |
| `tests/app/` | In-process calls to actual Next.js route handlers, including cookie identity and action/task controls |
| `tests/integration/` | Cross-module execution, persistence, recovery, concurrency and financial invariants |
| `tests/deploy-db-push.test.ts` | Current-schema provisioning, explicit SQLite reset and workspace boundaries |
| `tests/e2e/` | Real-browser journeys against the running application |

Route-handler integration executes real application code but does not validate browser rendering or the network stack. Browser assertions use rendered DOM as primary evidence, supplemented by read APIs and database facts for balances, ledger entries and audits.

## Core agent scenarios

| Scenario | Test under `tests/scenarios/` | Required behavior |
| --- | --- | --- |
| Balance query | `test-01-balance.test.ts` | GREEN query returns SDK facts |
| Small transfer | `test-02-transfer-confirm.test.ts` | Explicit confirmation precedes debit; balance and ledger agree |
| Large transfer | `test-03-transfer-mfa.test.ts` | RED verification is required; an incorrect code moves no money |
| Prompt injection | `test-04-prompt-injection.test.ts` | Input cannot bypass permissions or verification |
| Execution failure | `test-05-failure-report.test.ts` | Failure is reported without invented success |
| Spending analysis | `test-06-spending-analysis.test.ts` | Category totals reflect booked transactions |
| Anomaly detection | `test-07-anomaly.test.ts` | Detection uses transaction data |
| Card limits | `test-08-card-limit.test.ts` | A limit change requires confirmation |
| Investment operation | `test-09-investment-mfa.test.ts` | Purchase is gated by RED/MFA policy |
| Circuit breaker | `test-10-circuit-breaker.test.ts` | Repeated verification failure locks execution and creates audit evidence |
| Conditional plan | `test-11-conditional-dag.test.ts` | Dependencies and conditions control downstream nodes |
| Birthday plan | `test-12-birthday-plan.test.ts` | Budget and plan records do not imply actual locked funds or external purchases |

`mock-integration.test.ts` exercises the complete offline agent pipeline without an API key.

## Regression invariants

### Financial precision and settlement

- Financial JSON inputs are decimal strings; numeric inputs and fractional cents for booked money are rejected.
- Booked amounts use integer cents with signed INT64 bounds. Rates and unrounded valuations retain Decimal precision and use canonical strings in SQLite.
- `annualYieldRate` is a dimensionless ratio, with percentage conversion confined to presentation.
- Redemption applies the explicit HALF_UP settlement rule once. Authorization and execution agree on the settled amount; a changed quote cannot silently change an approved credit.
- Purchase and redemption replay return complete original results. Missing or corrupt current execution evidence is rejected rather than synthesized.

Primary specs: `tests/unit/financial-values.test.ts`, `tests/unit/banking-sdk/investment-precision.test.ts`, `tests/unit/banking-sdk/investment-flow.test.ts`, `tests/integration/money-budget.test.ts`, `tests/integration/transfer-receipts.test.ts` and `tests/integration/refactor-financial-commands.test.ts`.

### Authorization, identity and transaction boundaries

- A cumulative daily transfer total at the policy boundary remains YELLOW; exceeding it escalates to RED.
- Authorization binds the operation's identity and financial parameters. Cookie-owned user/session identity cannot be replaced by client-supplied identity.
- Repeated or concurrent confirmation cannot duplicate a committed debit.
- Business mutation, ledger evidence, execution receipt and required execution audit commit atomically. A required audit failure rolls back the write.
- A committed receipt must match its owner, request and ledger evidence. Reusing an execution identity for a different request is a conflict.
- The SDK rechecks execution authority inside the write transaction through the trusted invocation context. Cancellation that commits first blocks a later write; a business transaction that commits first remains a recorded fact.

Primary specs: `tests/unit/security/`, `tests/app/identity-http.test.ts`, `tests/app/concurrent-execution-http.test.ts`, `tests/integration/sdk-transaction-fences.test.ts`, `tests/integration/execution-audit.test.ts`, `tests/integration/transfer-replay.test.ts` and `tests/integration/write-idempotency.test.ts`.

### Durable events, tool invocations and recovery

- Pi events are persisted with ordered run sequences and tool invocation identities, including lifecycle and streaming events.
- A completed invocation replays its saved result. Pending confirmation/verification waits for authorization rather than retrying the tool.
- Read-only operations and receipt-backed idempotent writes have explicit retry capabilities and attempt limits. Unknown commit state requires reconciliation; permanent authorization or validation errors are not transient retries.
- Recovery uses verified persistent evidence. Missing terminal state after a proven commit converges to the original success result without a second business write.
- Lost or rotated execution authority prevents obsolete executors from mutating business state, replacing results or publishing late progress.
- Recovering an executed plan node restores its persisted result without invoking the tool again. A cancelled plan cannot start downstream work.
- A fresh process can reclaim an expired run after real `SIGKILL`. Incomplete model output is regenerated from the stored request, and a complete original decision executes only its recorded calls.
- A complete model result before tool admission, a committed DAG predecessor and a parked transfer before session persistence retain their original graph, operation and authorization identities.
- Model attempts, recovery admissions and transient backoff are persisted. Different tool declarations, provider endpoints, newer conversation revisions and missing write evidence stop automatic continuation.
- Workflow child reads and writes have their own durable invocation records. Explicit workflow retry does not bypass fresh authorization or reset the operation key.

Primary specs: `agent/durable/*.test.ts`, `tests/integration/agent-durability.test.ts`, `tests/integration/process-restart.test.ts`, `tests/integration/standalone-workflow-restart.test.ts`, `tests/integration/model-checkpoint-boundaries.test.ts`, `tests/integration/workflow-invocations.test.ts`, `tests/unit/agent/recovery-worker.test.ts`, `tests/integration/committed-outcomes.test.ts`, `tests/integration/node-result-recovery.test.ts`, `tests/integration/obsolete-executor.test.ts`, `tests/integration/restart-recovery.test.ts` and `tests/integration/recovery-authorization.test.ts`.

### Planning, response integrity and current API contracts

- Multi-step requests require a complete, validated plan before automatic writes or authorization creation. Step bindings reject omitted, duplicated, substituted or ambiguous recipients/products.
- Pause blocks later nodes; cancel revokes parked actions. Compensation affects only eligible owned budget/scheduled resources and does not erase booked transactions.
- Financial narration is derived from operation-specific server facts. Unknown results do not become invented success, failure or unchanged balances.
- Frontend parsers require the current API envelope, explicit action state/attention and complete product metadata. Obsolete field aliases and fabricated default financial values are rejected.

Primary specs: `tests/integration/live-complete-plan.test.ts`, `tests/integration/request-step-binding.test.ts`, `tests/integration/request-scope-holdings.test.ts`, `tests/integration/task-feature-hardening.test.ts`, `agent/financial-response.test.ts`, `tests/integration/financial-response-boundary.test.ts` and `tests/unit/planner/action-contract.test.ts`.

Provider transport deadlines, stalled streams, bounded transport retry and request cancellation are covered by `agent/providers/request-options.test.ts`. Controlled live-path recovery and retry UI state are covered by `tests/integration/live-recovery.test.ts` and `tests/integration/live-retry-ui.test.ts`. These exercise the live code path with scripted transport; they are not proof of a real provider response.

### Manual review and scheduled dispatch

`tests/app/manual-review-http.test.ts` checks durable review records, refresh, execution blocking during review, authorization after a continue decision, preservation of posted facts, rejection of unknown-result retries, identity, decision deduplication and audit rollback. See [Manual review](manual-review.md).

`tests/app/scheduled-dispatch-http.test.ts` and `tests/unit/planner/scheduled-command.test.ts` check scheduled dispatch through the current command and authorization contracts. See [Scheduled tasks](scheduled-tasks.md).

For a more detailed cross-module index, see [Integration test context](../tests/integration/CONTEXT.md).

## Browser acceptance journeys

The registered journeys in `tests/e2e/acceptance.e2e.ts` exercise the following behavior:

| Journey | Evidence |
| --- | --- |
| `a-transfer-confirm` | Confirmation, balance change and one new debit ledger entry |
| `b-transfer-mfa` | Correct-code success; incorrect code retains verification and moves no money |
| `c-plan-pause-resume` | Pause/resume controls and preservation of completed nodes |
| `d-plan-cancel` | Cancellation rejects stale confirmation without changing money or limits |
| `e-refresh-action-recovery` | Refresh restores YELLOW confirmation and RED verification |
| `f-wedge-refresh-recover` | Recovery of a committed action lacking terminal state, without a second debit |
| `g-manual-handoff` | Review persists across refresh; continue still requires authorization; unknown outcomes remain controlled |
| `h-investment-flow` | Purchase/redemption update holdings, balance and investment ledger entries |
| `i-anomaly-detection` | Income is not mistaken for suspicious spending; seeded anomalous spending is displayed |
| `j-circuit-breaker-lock` | Lock persists across refresh; invalid unlock codes fail; valid unlock creates audit evidence |

The harness can seed a fault-window fixture in its isolated database. This verifies the recovery surface and convergence behavior; it does not claim that the browser induced a real process crash. A skipped journey is reported with its reason and is not acceptance evidence for that journey.

## Evidence boundaries

Offline suites and browser acceptance simulate model output. The banking backend, products and MFA are themselves competition simulators. Real-provider acceptance records in `*-report.md` document specific historical runs and their limitations; they do not establish general natural-language robustness.

These suites do not establish real bank integration, real-money settlement, multi-instance deployment safety, cross-browser coverage, load capacity or accessibility conformance. Production build validation must be reported separately from development-server browser acceptance.
