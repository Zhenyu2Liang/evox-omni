# Testing and Acceptance

**English** | [简体中文](../cn/test-cases.md)

Tests are divided into offline regression, browser acceptance, and real-model acceptance.
Each acceptance run records the model source and the actual scope of execution.
The number of tests is determined by the output of the corresponding command.

Dual-card freeze acceptance checks independent authentication, operation records, and historical plan positions.
An incorrect verification code must not freeze the card, and the first card's verification must not authorize subsequent cards.
The browser separately checks refresh and subsequent conversations; API success is not used as a substitute for page verification.
Contact acceptance includes concurrent duplicate submissions, per-user isolation, and audit rollback.
Security center acceptance checks the developer switch, unlock conditions, and the final state of the original operation.
Card page acceptance checks page-based add/delete, independent verification, and refresh recovery.
New physical card and card deletion requests return only page operation instructions.
Virtual card applications and lost-card reissues can still be handled through Agent authorization.
Manual verification acceptance first checks that normal mode rejects, then demonstrates background processing.

For the runtime environment, see [Development Guide](development.md).
For recovery rules, see [Persistence and Recovery](agent-durability.md).
For business limits, see [Current Limitations](known-risks.md).
For the meaning of names, see [Glossary](terms.md).

## Common Commands

For the dedicated commands and isolated test database for billing reports, see [Billing Report Regression Tests](bill-reports.md#regression-testing).

Run the following commands in the project root directory.

```sh
pnpm test
pnpm test tests/unit
pnpm test tests/scenarios
pnpm test tests/app tests/integration
pnpm test agent/durable tests/integration/process-restart.test.ts
pnpm typecheck
pnpm lint
pnpm exec tsx tests/e2e/acceptance.e2e.ts
```

`pnpm test` uses the [Vitest configuration](../../vitest.config.ts).
The configuration collects only `*.test.ts` and `*.spec.ts` under `tests/`, `agent/`, `security/`, and `planner/`.
`*.e2e.ts` and `*.e2e-helper.ts` do not match this pattern, so browser and boundary entry points are always run separately.
The configuration pins `testTimeout` to 20 seconds and sets `fileParallelism: false`.
Conversation-driven test cases take an explicit per-test budget from [Test Budget](../../tests/helpers/timeouts.ts).
Test cases that drive real `POST /api/chat` rounds pass `CHAT_DRIVEN_TEST_TIMEOUT_MS`.
Test cases using a cold, self-built store pass `COLD_DB_PROVISION_TEST_TIMEOUT_MS`.
Both are passed as the third argument to `it(...)`.
They must not be rewritten as bare numbers, and these two constants must not be copied inside test case files.

The production build is run separately with `pnpm build`.
Before building, first generate a Prisma Client that matches the current schema.
Pages read language and business data per request; the build does not query the database.
Prisma commands run in an offline environment and set three variables.
The three variables are `CHECKPOINT_DISABLE=1`, `PRISMA_HIDE_UPDATE_MESSAGE=1`, and `CI=1`.
If missing, `pnpm db:generate` may stall on the update check.
Command output and file logs that need to be retained are written to `logs/`.
No `.log` file is placed in the repository root.
For preparation steps, see [Development Guide](development.md).

## Language Switching Acceptance

Browser acceptance includes the Chinese default and switching between Chinese and English.
Even if the browser prefers English, the first visit still displays Chinese.
Language can be switched from both the desktop sidebar and the mobile top bar.
After refreshing the page, the selection is retained, and server-side business pages use the same language.
During switching, check drafts, message identifiers, and transaction records.
Switching languages must not add bank business submissions.
For test cases, see [i18n.e2e-helper.ts](../../tests/e2e/i18n.e2e-helper.ts).

## Shared Conversation and Display Acceptance

Different browsers directly enter the same demo user and session.
Greetings, amount corrections, ambiguous card requests, and chat confirmations must return different prompts.
Subsequent balance queries must still obtain real tool results.
These conversations must not create write operations or workflows due to old intents.
Model input and model result checkpoint recovery must also follow the same rule.

User text is displayed as-is; assistant body text uses Markdown.
Tool cards display the actual invocation, status, and result summary.
Exact amounts must not change due to format rendering.
For test cases, see [shared-demo.e2e-helper.ts](../../tests/e2e/shared-demo.e2e-helper.ts).
Real-model acceptance can use `LIVE_SCENARIOS=0` to select this group of test cases.

Subscription queries also need to verify the complete authorization process.
After confirmation, the original invocation should show as completed and no longer show as executing.
Subsequent greetings and balance queries must not flash the previous round's invocation.
After refreshing the page, the completed status must still be retained.
For test cases, see [tool-lifecycle.e2e-helper.ts](../../tests/e2e/tool-lifecycle.e2e-helper.ts).
Real-model acceptance uses `LIVE_SCENARIOS=8` to select this group of test cases.

Ordinary conversation needs independent verification; it is not enough to test only whether tools execute.
Funding source explanations, casual chat, and scheduled task capability inquiries should return natural answers.
These questions must not generate authorizations, plans, or continue an old transfer draft.
After refresh, the original answer is retained, and a subsequent explicit transfer still requires confirmation.
For test cases, see [Normal Conversation Acceptance](../../tests/e2e/conversation.e2e-helper.ts).
Offline acceptance uses `E2E_JOURNEYS=natural-conversation-and-financial-boundary`.
Real-model acceptance uses `LIVE_SCENARIOS=11`.

Negative amounts, historical review, and continued analysis use the same browser flow.
After entering `转给张伟-10元`, do not query contacts or generate authorization.
Subsequent follow-up questions and refresh must still be able to recall the negative sign in the original sentence.
After a subscription query completes, continued analysis must retain the price, suggestion, and natural text.
The analysis does not cancel the subscription, nor does it generate a new confirmation entry point.
Offline acceptance uses `E2E_JOURNEYS=signed-amount-memory-and-subscription-analysis`.
Real-model acceptance uses `LIVE_SCENARIOS=12`.

## History Pagination and Context Compression Acceptance

The chat page initially displays only the most recent 20 complete messages.
When loading an old page, check message order, deduplication, and reading position.
A single long reply must not be truncated, and input drafts must not be lost due to pagination.
When a new reply arrives, readers who have left the bottom can choose to view the new message.
After clearing, a late old pagination response must not enter the new conversation.
For test cases, see [History Pagination Acceptance](../../tests/e2e/chat-history.e2e-helper.ts).
Offline acceptance uses `E2E_JOURNEYS=chat-history-pagination-and-scroll`.

Compression acceptance separately checks the original archive and the actual model request.
The original negative sign, complete long messages, and assistant replies must continue to be retained.
The actual model request must use summaries and recent complete rounds.
After summary generation is interrupted, recover the original request without duplicating user messages.
After an ordinary model request is interrupted, resend the original compressed view.
Summaries that have already been completed must not be regenerated due to a new threshold.
When confirming an old operation, subsequent chat and tool results must be fully retained.
Duplicate tool call identifiers are updated according to their original model request attribution.
For test cases, see [Compression Recovery Tests](../../tests/integration/conversation-compaction.test.ts).
Real-model acceptance uses `LIVE_SCENARIOS=13`.
This scenario sets the compression threshold of the isolated service to `16000` token.
The scenario uses synthetic history to check real summaries and negative amount recall.
For an explanation, see [Context Compression](context-compaction.md).

## Developer Mode Acceptance

Developer mode is disabled by default.
Normal navigation shows operation records and hides run records and operation audits.
Both refreshing the page and "Refresh Conversation" retain existing messages.
Canceling the clear dialog must not modify the conversation.
After confirming clear, all browsers read the new conversation context.
Ledgers and run evidence must be retained, and pending operations must block clearing.
Both desktop and mobile need to verify the switch, confirmation dialog, and clearing result.
For test cases, see [developer-mode.e2e-helper.ts](../../tests/e2e/developer-mode.e2e-helper.ts).
`E2E_JOURNEYS=developer-mode-conversation-controls` can be used for separate acceptance.

## Operation Records and Operation Audit Acceptance

Ordinary users can view business names, times, statuses, and verification results.
Neither the normal page nor the API displays original tool names, parameters, and results.
Query tools and task plan events must not push business records out of pagination.
Client identity parameters must not be able to select other users or sessions.
When the result is unknown, display pending verification; historical records do not provide an execute button.

When developer mode is disabled, directly accessing the operation audit page must not be able to read technical data.
`GET /api/audit` returns HTTP 403 before parsing filter parameters.
After enabling the mode, the page displays the original audit details.
After disabling the mode, navigation and technical pages return to normal mode.

For API test cases, see [activity-http.test.ts](../../tests/app/activity-http.test.ts).
For projection test cases, see [operation-history.test.ts](../../tests/unit/audit/operation-history.test.ts).
For browser test cases, see [activity.e2e-helper.ts](../../tests/e2e/activity.e2e-helper.ts).
`E2E_JOURNEYS=operation-history-and-developer-audit` can be used for separate acceptance.

## Data Isolation and Execution Order

Each test entry point uses an isolated database.

| Test entry point | Database | Model source |
| --- | --- | --- |
| Vitest | `prisma/test.db` | Offline simulation or controlled responses |
| Offline browser acceptance | `prisma/e2e.db` | Offline simulation |
| Real-model browser acceptance | `prisma/live-acceptance.db` | DeepSeek |
| HTTP boundary acceptance | `prisma/live-acceptance-date-tamper.db` | Offline simulation |
| WeChat channel acceptance | `prisma/weixin-live-<runId>.db` | DeepSeek |

The test entry point sets `DATABASE_URL` before importing application code.
The test entry point generates the Prisma Client and creates the current schema.
Tests that use the database create seed data themselves.
`LLM_MODE=mock` in the configuration makes Vitest run offline by default.

Warning: the test entry point rebuilds the isolated data in the tables.
If acceptance data needs to be retained, first save a copy of the database.
Do not handle test failures by resetting `prisma/dev.db`.

Note: all Vitest files share the same resettable `prisma/test.db`.
The configuration uses `fileParallelism: false` to run files sequentially.
Do not run two processes that reset the same test database at the same time.
Two `pnpm test` will reset the test database against each other, producing false failures.
Browser entry points use the independent databases in the table, and entry points that reset the same database must not be run at the same time.
Development, browser development acceptance, and production acceptance use `.next`, `.next-e2e`, and `.next-build`, respectively.
Services using the same output directory must not be run during the build.

If database initialization fails, check the initialization diagnostics.
First check the Prisma Client, schema, and isolated database path.
The test environment fixes the log level of the schema engine.
Initialization failures retain the Prisma command output.
For the code, see [Test Initialization](../../tests/setup.ts).

## Test Layers

| Directory or file | What is checked |
| --- | --- |
| `tests/unit/` | Financial values, bank transactions, permissions, plans, and interface contracts |
| `agent/**/*.test.ts` | Persistent runs, model transport, and trusted financial replies |
| `security/**/*.test.ts` | MFA rejection reasons and determination of consumed challenges |
| `planner/**/*.test.ts` | Plan-driven guards and plan failure contracts |
| `tests/scenarios/` | Controlled model-driven banking agent scenarios |
| `tests/app/` | Actual route handlers, fixed demo identity, and operation controls |
| `tests/integration/` | Cross-module execution, persistence, recovery, and concurrency constraints |
| `tests/deploy-db-push.test.ts` | Current schema database creation, explicit reset, and directory boundaries |
| `tests/helpers/` | Isolated databases, fixtures, scripted models, and process recovery probes |
| `tests/fixtures/` | Shared `*.zh-CN.json` conversation and policy scripts |
| `tests/e2e/` | Browser operations and HTTP boundary test cases for the running application |

The main entry points of `tests/e2e/` include `acceptance.e2e.ts`, `live-acceptance.e2e.ts`, `date-tamper-boundary.e2e.ts`, and `weixin-live.e2e.ts`.
`*.e2e-helper.ts` and `helpers.ts` are driver and assertion modules shared by the entry points and do not run themselves.

Route tests directly call the actual handlers.
Route tests do not check browser rendering and network transport.
Browser acceptance uses the rendered page as the primary evidence.
Read-only APIs and the database are used to verify account facts.

## Core Scenarios

The core scenario files are located in [tests/scenarios](../../tests/scenarios).

| Scenario | Test file | Expected behavior |
| --- | --- | --- |
| Balance query | `test-01-balance.test.ts` | A green query returns facts from the bank SDK |
| Small transfer | `test-02-transfer-confirm.test.ts` | Deduction after confirmation, with balance and statement consistent |
| Large transfer | `test-03-transfer-mfa.test.ts` | Red permission requires multi-factor authentication (MFA); wrong code does not deduct |
| Prompt injection | `test-04-prompt-injection.test.ts` | User input cannot bypass permissions and verification codes |
| Execution failure | `test-05-failure-report.test.ts` | The reply retains the failure fact and does not fabricate success |
| Spending analysis | `test-06-spending-analysis.test.ts` | Category amounts come from posted statement entries |
| Anomaly detection | `test-07-anomaly.test.ts` | Anomaly results come from transaction data |
| Card limit | `test-08-card-limit.test.ts` | Limit is changed after user confirmation |
| Wealth management operation | `test-09-investment-mfa.test.ts` | Subscription goes through red permission and MFA |
| Circuit-breaker lockout | `test-10-circuit-breaker.test.ts` | Consecutive wrong codes lock execution and save an audit |
| Conditional plan | `test-11-conditional-dag.test.ts` | Dependencies and conditions control subsequent nodes |
| Birthday plan | `test-12-birthday-plan.test.ts` | Budgets and plan records do not represent actual fund freezing |
| Reissue lost card | `test-13-card-replace.test.ts` | A new card is generated after red permission confirmation, and the original card remains `LOST` |
| Apply for virtual card | `test-14-virtual-card.test.ts` | After MFA, issue a virtual card bound to the current account |
| Credit limit guard | `test-15-card-limit-guard.test.ts` | The agent can only change the monthly limit, not the credit limit |
| Virtual card lifecycle | `test-16-virtual-card-lifecycle.test.ts` | Application, spending, loss reporting, and reissue share the same monthly limit; replay deducts only once |
| Posting time guard | `test-17-consumption-time-guard.test.ts` | Client time parameters are rejected before any write, and the deduction is zero |
| Card capability inquiry | `test-18-card-capability-consultation.test.ts` | Inquiries and ambiguities produce only text or clarification, with no card changes |
| Credit card reissue | `test-19-card-replace-credit-runtime.test.ts` | In production runtime, after MFA only 1 `CREDIT` card is generated, and the original card remains `LOST` |
| Card selector spending | `card-selector-consumption.test.ts` | Type and last digits resolve to `cardId`; full card numbers are rejected before park |

`mock-integration.test.ts` checks the complete offline processing flow.
Offline tests do not require an API Key.

## Model Adapter Regression

Adapter tests use controlled requests and test keys.
The tests check request format and do not prove that a real model is available.

| Test entry point | What is checked |
| --- | --- |
| [Runtime adapter](../../tests/unit/agent/providers/provider-runtime.test.ts) | Native provider paired with `model`, `streamFn` |
| [Online adapter](../../tests/unit/agent/providers/provider-live.test.ts) | Custom provider address, authentication, and registered models |
| [Simulated adapter](../../tests/unit/agent/providers/provider-mock.test.ts) | Independent scripted model, no network |
| [Message pairing](../../tests/unit/agent/message-normalize.test.ts) | Authorization results correspond to the original tool call |

## Finance and Authorization Regression

Finance regression simultaneously checks input, calculation, posting, and execution receipts.

| Check target | Result that must be maintained | Test entry point |
| --- | --- | --- |
| Amount input | JSON financial values use decimal strings; posting amounts reject fractions below cents | [Financial values](../../tests/unit/financial-values.test.ts) |
| Financial calculation | Posting amounts use integer cents; interest rates and unsettled valuations retain Decimal precision | [Investment precision](../../tests/unit/banking-sdk/investment-precision.test.ts) |
| Redemption settlement | Settled 1 times according to the HALF_UP rule; quote changes require reauthorization | [Investment flow](../../tests/unit/banking-sdk/investment-flow.test.ts) |
| Duplicate transfer | Duplicate or concurrent confirmation produces only 1 deduction | [Transfer replay](../../tests/integration/transfer-replay.test.ts) |
| Write transaction | Business, statement, execution receipt, and required audit are committed or rolled back together | [Execution audit](../../tests/integration/execution-audit.test.ts) |
| Execution receipt | The receipt matches the user, original request, and ledger; reject when identity is reused but parameters change | [Transfer receipt](../../tests/integration/transfer-receipts.test.ts) |
| Commit validation | A cancellation committed first blocks subsequent writes; a transaction committed first retains its facts | [Transaction commit validation](../../tests/integration/sdk-transaction-fences.test.ts) |
| Authorization summary | After cumulative transfers are upgraded to red permission, the summary and verification entry point are consistent | [Authorization and Clarification](../../tests/integration/decision-guidance.test.ts) |
| Cards and holdings | Save the monthly limit, reject ambiguous holdings, retain the original redemption quote | [Cards and Holdings Regression](../../tests/integration/frontend-followup-fixes.test.ts) |

`annualYieldRate` is a dimensionless ratio.
Convert to a percentage only for display.
The credited amount is also limited by the signed 64-bit integer range.

## Core Contract Regression

Net value, redemption basis, locking, parsing, and consumption each have dedicated test cases.

| Contract | Result that must be preserved | Test entry point |
| --- | --- | --- |
| Net value and shares | Net value 4 bits, shares 6 bits, market value not rounded, settlement rounded by `HALF_UP` to 1 decimal places | [Net Value Model](../../tests/unit/banking-sdk/net-value.test.ts), [Redemption Model](../../tests/unit/banking-sdk/net-value-redemption.test.ts) |
| Redemption basis | `SHARES`, `AMOUNT`, and `ALL` are settled separately; missing, mixed, or `redeemAmount` is clarified before writing | [Basis Rejection](../../tests/unit/security/redemption-stale-authorization.test.ts), [Tool Parameters](../../agent/tools/redeem-investment.test.ts) |
| Confirmation snapshot | Returns `CONFLICT` when the net value, shares, or net value date changes; funds, shares, and records are all unchanged | [Stale Authorization](../../tests/unit/security/redemption-stale-authorization.test.ts) |
| Post-write projection | Subscription and redemption cards show holdings re-read after submission, not a pre-write snapshot | [Holdings Projection](../../agent/tools/redeem-investment.test.ts) |
| MFA terminal state | After attempts are exhausted, the action is set to `locked`; a correct verification code does not reopen it | [Terminal State Lock](../../tests/app/mfa-terminal-lock-http.test.ts), [Interface Contract](../../tests/app/mfa-lock-http-contract.test.ts) |
| Lock recovery | Terminal-state locks are not revived by recovery, retry, or cancellation | [Lock Recovery](../../tests/integration/locked-action-recovery.test.ts) |
| Owner circuit breaker | The circuit breaker takes effect according to `user:<userId>`, and the reason comes from the attempt records of this operation | [Reason Determination](../../security/mfa-lock-reason-authority.test.ts), [Persistence](../../tests/unit/security/circuit-breaker-persistence.test.ts) |
| External copy | Structured `SecurityFailure` determines the text; internal markers do not enter public text | [Lock Copy](../../tests/unit/lib/public-text.locked.test.ts), [Internal Diagnostics](../../tests/unit/lib/public-text.test.ts) |
| Number identity | The object is determined only when the complete numbers are equal; masking only narrows the candidates | [Number Identity](../../tests/unit/lib/phone-identity.test.ts), [Payee Resolution](../../tests/unit/security/recipient-resolution.test.ts) |
| Card identity | An exact hit on the full card number; if the middle four digits differ, it is not found; shared suffix numbers are clarified as ambiguous | [Card Resolution](../../tests/unit/security/card-resolution.test.ts), [Selector Gateway](../../tests/unit/security/card-selector-gateway.test.ts) |
| Virtual card consumption | Deduction, records, and `CardConsumption` in the same transaction; monthly limit merged by replacement family | [Consumption Transaction](../../tests/integration/card-consume-transaction.test.ts), [Consumption Interface](../../tests/app/card-consume-http.test.ts) |
| Consumption time | The posting time is determined by the server-side `demoNow()`; client time parameters are rejected | [Time Authority](../../tests/unit/banking-sdk/card-consumption-time-authority.test.ts), [Time Guard](../../tests/scenarios/test-17-consumption-time-guard.test.ts) |
| Consumption replay | The same execution key deducts only 1 time and returns the original result | [Lifecycle](../../tests/scenarios/test-16-virtual-card-lifecycle.test.ts), [Consumption Interface](../../tests/app/card-consume-http.test.ts) |

For net value and share basis, see [Wealth Management Net Value](investments.md).
For the determination order of locking and circuit breaking, see [Security](security.md).
For consumption time and limit basis, see [Card Management](card-management.md).

## Security Fix Regression

When modifying security mechanisms, run the affected regressions in the table below.
The test cases check real pending-confirmation operations, funds, terminal states, and execution receipts.

| Check target | Result that must be preserved | Test entry point |
| --- | --- | --- |
| Handling status and clarification | Fictional submissions are not disclosed; no guessing when the card is missing; corrections preserve the question | [Declarations and Clarification](../../tests/integration/financial-claim-and-clarification.test.ts), [Reply Checks](../../agent/reply-safety.test.ts) |
| Cancelled status | The terminal state of the current user and session replaces the old waiting state in the request view without changing the archive | [Current Status](../../tests/integration/workflow-context.test.ts) |
| Balance and holdings descriptions | Use real balances and product names; internal holding IDs do not enter public summaries | [Financial Basis](../../agent/grounding-integration.test.ts), [Holding Facts](../../agent/tools/redeem-investment.test.ts) |
| Model call budget | Retries and recovery share the reserved amount; output stops on timeout | [Total Budget](../../agent/model-budget.test.ts) |
| Correction declarations | Compatibility mode requires only `describe_turn` and does not force financial calls | [Declaration Constraints](../../agent/providers/required-declaration.test.ts) |
| Host and same-origin | Page and API access via unknown domains are both rejected; legitimate local requests are preserved | [Shared Boundary](../../tests/unit/security/http-write-boundary.test.ts), [Proxy](../../tests/app/request-host-proxy.test.ts) |
| Request size | Reject when the JSON body and chat text exceed the limit, including streaming bodies | [Message Length](../../tests/app/chat-request-size.test.ts) |
| Page consumption | The first proposal does not deduct funds; the original parameters bind the verification code, account lock, and original receipt | [Consumption Authorization](../../tests/app/card-consumption-security.test.ts) |
| Category limits and replacement | Cross-transaction consumption accumulates monthly, replacements inherit the limit, and replay does not overwrite the new limit | [Category Limits](../../tests/unit/banking-sdk/card-category-limit.test.ts), [Replacement Replay](../../tests/integration/replace-card-replay.test.ts) |
| Cross-process contention | The same execution key deducts funds only once; balance and category limits are not breached concurrently | [Multi-process Transactions](../../tests/integration/sdk-multiprocess-transaction.test.ts) |
| Special plan nodes | Special names can be referenced; path separators and control characters are rejected | [Node Validation](../../tests/unit/planner/dag.test.ts), [Conditional Execution](../../tests/unit/planner/executor.test.ts) |

For example, to run only the offline regression for budget and declaration fixes:

```sh
pnpm exec vitest run agent/model-budget.test.ts agent/providers/required-declaration.test.ts tests/integration/financial-claim-and-clarification.test.ts
```

The number of tests is subject to the output of the command for that run.

## Persistence and Process Recovery Regression

Recovery tests check the original identity and original financial facts.
Completion status alone cannot replace a financial receipt.

| Check target | Expected behavior | Test entry point |
| --- | --- | --- |
| Pi events | Lifecycle and streaming events are persisted by run sequence number | [Persistence Integration](../../tests/integration/agent-durability.test.ts) |
| Model checkpoint | Preserve the original request, attempt limit, and backoff time; reject stale revisions | [Model Checkpoint](../../tests/integration/model-checkpoint-boundaries.test.ts) |
| Model generation interruption | Regenerate from the original request; do not execute a partial tool call | [Process Restart](../../tests/integration/process-restart.test.ts) |
| Complete model decision | Execute the original call identifier and parameters; do not rebuild the original decision | [Process Restart](../../tests/integration/process-restart.test.ts) |
| Committed write | Verify the original receipt and then restore the original result; do not repeat business operations and auditing | [Committed Result](../../tests/integration/committed-outcomes.test.ts) |
| Awaiting authorization | Preserve the original confirmation or MFA; do not authorize on the user's behalf | [Recovery Authorization](../../tests/integration/recovery-authorization.test.ts) |
| Workflow subcall | Save the parent call, node, and execution key; explicit retry still requires authorization | [Workflow Call](../../tests/integration/workflow-invocations.test.ts) |
| Original graph recovery | Reuse the original graph and completed nodes; preserve paused, cancelled, and manual-review states | [Independent Workflow Restart](../../tests/integration/standalone-workflow-restart.test.ts) |
| Invalid executor | After losing the execution lease, it cannot submit funds or overwrite results | [Old Executor](../../tests/integration/obsolete-executor.test.ts) |
| Recovery worker | Limit batch size, isolate single-run failures, and wait for the current execution to complete on exit | [Recovery Worker](../../tests/unit/agent/recovery-worker.test.ts) |

`process-restart.test.ts` uses a real subprocess.
The test sends `SIGKILL` at the specified execution point.
A new subprocess recovers the original run from the database.
The test sets the lease expiration in advance, avoiding the wait for expiration.
Model transport is controlled; Pi, permissions, and bank transactions use project code.

Browser fault fixtures only construct persisted fault states.
Browser fault fixtures do not prove that the page triggered a real process crash.

## Plan, Reply, and Interface Regression

Multi-step requests must first save a plan covering all explicit steps.
The plan uses a directed acyclic graph (DAG) to represent dependencies.
Pre-checks reject missing steps, duplicates, object substitutions, and amount mismatches.
During execution, the user's own resources, permissions, and quotes are checked again.

| Check target | Expected behavior | Test entry point |
| --- | --- | --- |
| Complete plan | An incomplete plan cannot first create a budget, authorization, or transfer | [Multi-step Plan](../../tests/integration/live-complete-plan.test.ts) |
| Negation and holdings | Additional negation preserves positive steps; redemption is bound to the actual user's holdings | [Request Scope and Holdings](../../tests/integration/request-scope-holdings.test.ts) |
| Pause and cancel | Pause blocks subsequent nodes; cancel revokes pending authorization | [Task Control](../../tests/integration/task-feature-hardening.test.ts) |
| Financial replies | Use only server-side business facts; unknown results do not become success or failure | [Reply Boundary](../../tests/integration/financial-response-boundary.test.ts) |
| Entities and pages | Reject resource ambiguity; exception details bind to the selected records | [Frontend Regression](../../tests/integration/frontend-review-fixes.test.ts) |
| Clarification | Preserve the products already provided; reject model-fabricated states and amounts | [Authorization and Clarification](../../tests/integration/decision-guidance.test.ts) |
| Model requests | The deadline covers stalled streams; transport retries are bounded; user cancellation does not retry | [Request Limits](../../agent/providers/request-options.test.ts) |
| Planning retry | Preserve the retry entry point when no business operation was executed; a new message invalidates the old entry point | [Planning Recovery](../../tests/integration/live-recovery.test.ts), [Retry Interface](../../tests/integration/live-retry-ui.test.ts) |

Plan pre-checks do not guarantee atomic success of the entire graph.
Failure of subsequent nodes does not revoke transactions already posted.
For manual review tests, see [Manual Review HTTP Tests](../../tests/app/manual-review-http.test.ts).
For scheduling tests, see [Scheduled Dispatch HTTP Tests](../../tests/app/scheduled-dispatch-http.test.ts).
For operating instructions, see [Manual Review](manual-review.md) and [Scheduled Tasks](scheduled-tasks.md).

## Browser Acceptance

The offline browser entry point uses the system Chrome.
If Chrome is not found, it tries Edge.
`E2E_BROWSER_PATH` can specify the browser executable.
The entry point selects an idle port and starts the actual Next.js development service.
At the end of acceptance, the browser and service process tree are closed.

The current offline entry point registers 23 flows in `JOURNEYS`.
`E2E_JOURNEYS` selects a subset by name; if unset, all flows are executed.
The table below lists 11 of the funds and permission main flows.
For the remaining flows, see the sections above.

| Flow identifier | Main evidence |
| --- | --- |
| `workspace-http-and-mobile` | Home page, request identifier fallback, input method, mobile navigation, and exact chart tooltips |
| `a-transfer-confirm` | Confirmation, balance change, and 1 new deductions |
| `b-transfer-mfa` | A wrong code does not deduct funds; a correct code completes the original operation |
| `c-plan-pause-resume` | Pause, resume, and preservation of completed nodes |
| `d-plan-cancel` | After cancellation, the old confirmation is rejected; funds and limits are unchanged |
| `e-refresh-action-recovery` | Refresh restores the yellow confirmation and red verification |
| `f-wedge-refresh-recover` | Recovery of a submitted but unfinished operation without duplicate deduction |
| `g-manual-handoff` | Manual review is preserved on refresh; authorization is still required after resuming |
| `h-investment-flow` | Holdings, balances, and records are consistent for subscription and redemption |
| `i-anomaly-detection` | Income is not treated as anomalous consumption; seeded anomalous consumption is displayed |
| `j-circuit-breaker-lock` | The lock is preserved after refresh; a correct unlock leaves an audit record |

Each flow outputs `PASS`, `FAIL`, or `SKIP`.
Any `FAIL` causes the entry point to return a non-zero exit code.
`SKIP` does not cause the entry point to fail, nor does it count as acceptance passed.
For the entry point, see [Offline Browser Acceptance](../../tests/e2e/acceptance.e2e.ts).
`pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts` runs HTTP boundary cases.
This entry point does not send model requests or start a browser.
The boundary entry point outputs each item according to `PASS|FAIL|SKIP <case-id>` and summarizes with `SUMMARY`.
`pnpm exec tsx tests/e2e/weixin-live.e2e.ts` runs WeChat channel acceptance.
This entry point uses a local protocol server and does not impersonate a real phone.

Interface flows check mobile widths of 390px and 320px.
The flows simulate an environment where ordinary HTTP lacks `randomUUID`.
No request is sent when selecting a suggestion or confirming an input method candidate.
After sending a balance query, the records do not change.
For the check code, see [Interface Acceptance](../../tests/e2e/ui-shell.e2e-helper.ts).

The test entry point checks the Prisma Client actually resolved.
The schema of the generated client must match the repository's current schema.
A client that can be instantiated but has outdated fields is regenerated.
For the regression test case, see [Client Generation Check](../../tests/unit/lib/prisma-client-generation.test.ts).

## Real Model Acceptance

Real model acceptance uses DeepSeek; the bank and MFA remain simulated.
The entry point uses local configuration through the Next.js environment loader.
The content of `.env.local` must not be read or displayed directly.
Real model requests may incur costs.

```sh
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
LIVE_SCENARIOS=1,3 pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

`LIVE_SCENARIOS` selects scenario numbers.
If unset, all scenario numbers registered by the entry point are executed.
Numbers `1`…`6` are transfer and multi-turn cases; `0` and `8`…`15` are dialogue and context cases.
`2p` is selected together with `2`; `lA`…`lL` cover cards, wealth management, locking, identity resolution, and old draft switching.
Multiple scenarios are executed sequentially by independent subprocesses, rebuilding a dedicated acceptance database each time.
`2` and `2p` remain in the same process and cover re-initiation after cancellation.
After each subprocess ends, the browser and server are closed to prevent account locking from affecting subsequent scenarios.
By default, the model identifier in the configuration is preserved.
`LIVE_FORCE_MODEL` can explicitly override the model identifier.
After overriding, the model identifier must be stated in the acceptance record.
For the entry point, see [Real Model Browser Acceptance](../../tests/e2e/live-acceptance.e2e.ts).

Production mode is fixed to use `.next-build`.
In PowerShell, build first, then start the specified scenario:

```powershell
$env:BANKING_NEXT_DIST_DIR = '.next-build'
pnpm build
$env:E2E_SERVER_MODE = 'production'
$env:LIVE_SCENARIOS = '2,15'
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

After modifying product code, that directory must be rebuilt.
By default, `pnpm build` writes to `.next` and does not update `.next-build`.
When switching back to development acceptance, remove `E2E_SERVER_MODE` from the current terminal.

Fault injection acceptance distinguishes between error responses and the source of success responses.
HTTP 503 injection is used to check fault handling.
Success responses generated by the script still count as controlled model evidence.
When normal requests are forwarded to DeepSeek, record the actual number of upstream requests.

## Acceptance Evidence and Limitations

The acceptance record must contain at least the following information.

1. Record the commit identifier, run command, and exit code.
2. Record the model source, model identifier, and actual scenario scope.
3. Save the counts and reasons for `PASS`, `FAIL`, and `SKIP`.
4. Save page evidence and operation identifiers.
5. Verify balances, records, execution receipts, and audits before and after the operation.
6. Verify whether new business records are added after refresh and repeated operations.
7. Record the number of model requests, distinguishing replanning from continuation of the original operation.
8. Record the isolated database path, configuration overrides, and fault injection method.

Save acceptance records and screenshots locally in ignored directories.
Ledger basis, total test counts, and build results are subject to re-execution.
If the certified commit is inconsistent with the product tree at the current HEAD, that conclusion does not extend to the current version.

Offline regression checks the application's behavior for specified responses.
Real model acceptance also cannot exhaustively cover natural language expressions.
Neither type of acceptance proves real bank or SMS integration.
Multi-instance deployment, cross-browser, load, and accessibility require separate acceptance.
The browser of the development service does not validate by substituting a production build.
