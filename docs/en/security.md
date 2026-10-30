# Security and Authorization

**English** | [简体中文](../cn/security.md)

The server-side code determines execution permission. Model text and the user's confirmation statements cannot grant execution permission.

Tool calls first pass parameter checks, then permission checks. Financial writes check execution permission again before the transaction commits.

## HTTP Request Boundary

HTTP writes reject foreign-site Origins and cross-site Fetch requests.
By default, only local addresses are accepted. Non-local deployments configure the full trusted addresses via `BANKING_ALLOWED_ORIGINS`.
The configuration includes protocol and port; separate multiple addresses with commas. Host and proxy request headers cannot add trusted addresses.
The reverse proxy must preserve the Host of the configured public address.
Public addresses may use HTTPS; HTTP may be used between the proxy and the application.
Domain checks cover the API, server-side pages, and static assets simultaneously.
Write requests with a body must use `application/json`.
The JSON body limit is 64 KiB, and the chat message limit is 4000 characters.
Page consumption first creates the original operation proposal; funds are deducted only after confirmation and passing MFA.
The deduction transaction checks the account lock, monthly limit, and category monthly spending limit simultaneously.
See [Trusted Access Addresses](development.md#trusted-access-addresses) for a deployment example.
See [request-origin.ts](../../lib/request-origin.ts), [proxy.ts](../../proxy.ts), and [http.ts](../../app/api/_lib/http.ts) for the code.

## Handling Declarations and Model Call Limits

When the handling target or amount is missing, the agent keeps the clarification open and waits for the user's answer.
The model must explicitly declare that the information is complete before it can propose a bank write.
Submission status and execution results are generated from the pending-confirmation operation and the execution receipt.
See [Bank Tool Contract](tool-contracts.md#this-rounds-declaration-and-information-completeness) for the declaration fields and clarification rules.
See [Handling Status and Balance](chat-presentation.md#handling-status-and-balance) for body validation and display rules.

Model calls are limited by the total number of calls per round, reserved tokens, and total duration.
Resuming does not reset the budget; generation stops once the limit is reached.
See [Development Guide](development.md#single-turn-model-call-budget) for the configuration.
See [Persistence and Resume](agent-durability.md#single-turn-model-call-budget) for the save and resume rules.

## Permission Levels

The [Tool Catalog](../../lib/contracts/tool-catalog.ts) defines tool effects and default permissions. Permission level and write effect are different fields.

| Level | Execution Condition | Tool Examples |
| --- | --- | --- |
| Green | Execute after parameter and identity checks pass | Query balance, bill analysis, create budget limit |
| Yellow | Execute after explicit user confirmation | Set card limit, cancel subscription, create scheduled intent |
| Red | Execute after user confirmation and completion of multi-factor authentication (MFA) | Wealth management subscription, wealth management redemption, freeze, report loss, unfreeze |

Transfers always require confirmation. When the sum of the single-transaction amount and the same-day cumulative amount exceeds 1000.00 yuan, the transfer is escalated to red.
The same-day cumulative amount includes posted transfers and authorized in-flight transfers. The same execution is not counted twice.
When in-flight amounts cannot be verified, the system refuses execution.

Querying subscriptions is also a yellow operation. Submitting a workflow is a green orchestration operation; each node still checks permissions separately.

The following policies are for the demo system and do not represent actual bank rules.

| Operation | Level | Basis |
| --- | --- | --- |
| Balance, transactions, spending, anomalies, cards, contacts, asset overview, wealth products and holdings, scheduled intent queries | Green | Reads the current user's data without changing bank state. |
| Query subscriptions | Yellow | Retains the query confirmation step required by the competition problem. |
| Create budget limit | Green | Only creates a bookkeeping budget; does not freeze or transfer funds; write audit is still recorded. |
| Set category spending limit | Yellow | Changes spending limits, not the total credit line. |
| Cancel subscription, change renewal reminder | Yellow | Requires user confirmation of the service change. |
| Page add/delete card | Red | Confirmed and verified by the user only on the card page; the Agent cannot initiate or execute. |
| Create scheduled intent | Yellow | Saves a future intent; permissions are rechecked when the specific business is executed at maturity. |
| Freeze, report loss, unfreeze card | Red | Changes card availability status. Confirmation and MFA are uniformly required to avoid multiple cards becoming unusable. |
| Wealth management subscription, redemption | Red | Changes funds and holdings. |
| Transfer | Yellow or red | Confirmation required; escalated to MFA based on single-transaction amount and same-day cumulative amount. |
| Submit workflow | Green orchestration | Does not authorize any bank write; each node passes through the permission gateway separately. |
| Page add/delete contact | Yellow | Saving the form or confirming deletion counts as explicit confirmation; the change is committed together with the audit. |

Freezing a single card also uses red permission. Two cards are each bound to an operation identity and an authentication challenge.
Completing verification for the first card does not authorize the second card. The confirmation endpoint rechecks the current static policy;
a saved lower-level decision cannot lower the verification requirement of the current red operation.

## Identity and Authorization Records

The web demo uses a single server-configured user and a shared session.
Pages and APIs do not require login and do not use identity cookies.
Different browsers view and operate on the same demo data.
Model parameters, request parameters, and old cookies cannot select another user.
The language cookie only stores UI preference.
Card and subscription writes must check the resource owner. The actual write conditions also include the owner.

Authorization records store the following:

- User, session, and original operation identity.
- Command digest, policy version, and decision reason.
- Risk inputs, permission level, and authentication requirements.
- Associated tool calls and pending-authorization operations.

Credentials in parameters are redacted before persistence. Authorization decisions and successful-execution audits are stored separately.
Unauthorized resource calls may return HTTP 200, but the business result is `data.ok=false`. Callers must check the business result.

Execution, resume, and cancellation audits all carry the user and session identity resolved by the server.
Operation records and operation audits are both scoped to the shared session of the fixed user.
Operation audit filtering and statistics use the same conditions.
Workflow execution audits also record the plan, nodes, and actual execution parameters.
Terminal-state audits recheck the operation owner within the transaction and read the original authentication challenge to fill in the verification facts.
When verification is required but no verification evidence is obtained, the page retains the unknown state.

## Operation Records and Operation Audits

Normal mode provides "Operation Records"; developer mode additionally provides "Operation Audits".

| Entry | Reader | Displayed Content |
| --- | --- | --- |
| `/activity`, `GET /api/activity` | Regular user | Business name, time, processing status, and identity verification status. |
| `/audit`, `GET /api/audit` | Demo developer | Risk decisions, tool names, execution parameters, tool results, and audit statistics. |

Operation records read only business write events, including card-page and contact-page operations.
Confirming one's own transaction is also a business operation and is retained in operation records.
Queries, workflow submissions, and maintenance events do not enter operation records.
The repository first filters business operations, then sorts and paginates.
Public fields contain only the event identifier, time, and closed enumerations.
Raw tool results, parameters, request text, and execution control identifiers are not returned.

Operation records are displayed by audit event; one business item may leave multiple status records.
"Unfinished" means processing is incomplete and does not prove that funds are unchanged.
Operations with unknown results are displayed as "Pending Verification".
Historical records do not provide confirm or re-execute buttons.

The operation audit page checks developer mode before reading data.
The operation audit API checks the mode first; normal mode returns HTTP 403.
The mode cookie only stores the demo display preference and does not constitute production administrator authentication.

## Multi-Factor Authentication

The current authentication adapter uses the demo verification code `123456`. The system does not send SMS.

Authentication challenges follow these rules:

- The challenge is bound to the original operation and the command digest.
- The challenge is timed in real time and is valid for 5 minutes.
- Reissuing a valid challenge preserves the failure count.
- The verification failure limit is 3 times.
- Consumed, expired, or command-changed challenges cannot pass verification.
- Unsupported authentication modes fail directly.

After a normal operation's challenge expires, the system reissues the challenge.
The old verification code submitted in this attempt does not verify the new challenge.
The user must submit the verification code again.
Challenges that have not yet expired continue to be reused, and the failure count is not reset.

Confirmation and authentication endpoints only handle the current pending-decision state. Terminal-state operations do not regain execution permission.
Before changing the amount or payee, the original authorization must be cancelled and the request re-initiated.

See [mfa.ts](../../security/mfa.ts) and [security-gateway.ts](../../security/security-gateway.ts) for the verification code challenge and permission gateway code.

### Structured Security Failures

The web page and WeChat may display only fallback text such as "Operation not completed".
The rejection facts are written only in structured fields.
The text is derived from these fields, not extracted from the original text.
Callers select wording by field, without keyword matching.
When there are no renderable fields, the outlet uses the wording fallback text.
When the field combination cannot be classified, the outlet uses the "Security check failed" wording.
The fallback text contains no internal reason and does not assert whether funds changed.

The rejection facts are carried by `SecurityFailure`; see [Security Contract](../../lib/contracts/security.ts) for the definition.

| Field | Meaning |
| --- | --- |
| `code` | Public error code, including `MFA_FAILED`, `MFA_LOCKED`, `CIRCUIT_OPEN`, `MANUAL_REVIEW_HOLD`. |
| `reason` | `mfa_code_invalid`, `mfa_attempts_exhausted`, `mfa_session_locked`, `circuit_open`, `manual_review_hold`, `denied`. |
| `actionId` | The rejected original operation. |
| `attemptsUsed`, `attemptsLeft`, `maxAttempts` | Used attempts, remaining attempts, and limit. |

The error type and renderable parameters are server-authoritative fields.
Callers select text only by these fields and do not match text content.
`AuthorizationResult.failure` is the structured rejection handed by the gateway to the runtime.

### Per-Attempt Results of Verification Failure

The failure limit is 3 times; the 3-th failure locks.

| Attempt | Top-level `code` | `failure.code` | `failure.reason` | Remaining Attempts | Operation Status |
| --- | --- | --- | --- | --- | --- |
| 1, 2-th | `MFA_FAILED` | `MFA_FAILED` | `mfa_code_invalid` | 2, 1 | `awaiting_mfa` |
| 3-th | `CIRCUIT_OPEN` | `MFA_LOCKED` | `mfa_attempts_exhausted` | 0 | `locked` |
| Submit again after lock | `CIRCUIT_OPEN` | `CIRCUIT_OPEN` | `mfa_session_locked` | 0 | `locked` |

The `attemptsLeft` returned by the 1, 2-th failures are, in order, 2 and 1.
The 1, 2-th failures only accumulate the challenge's attempt count and do not write `PendingAction`.
The 3-th failure does 3 things at once:

- Writes `PendingAction` from `pending` or `awaiting_mfa` to `locked`.
- Writes `MfaChallenge` to `locked`.
- Triggers the circuit breaker for this account.

The top-level `code` of the 3-th attempt is `CIRCUIT_OPEN`.
The lock reason is represented by `MFA_LOCKED` of `failure.code`.
Callers render by the `failure` field and do not read the top-level `code` to infer the reason.

Submitting confirmation or verification again after the lock returns a rejection with `code` as `CIRCUIT_OPEN`.
The `reason` of such rejections is `mfa_session_locked`.
The rejection does not create a new verification code challenge and does not provide a verification code entry.
The rejection does not consume attempt counts and does not execute business changes.

Whether this operation has exhausted attempts is determined by `mfa.attemptState`.
This determination reads the challenge row of this operation itself, not the account circuit-breaker state.
When the account is already tripped but this operation is not exhausted, `reason` is `circuit_open`.
The `failure.code` of this branch is likewise `CIRCUIT_OPEN`, and this operation is written as `locked`.
The operation-level limit and the account-level circuit breaker are therefore not confused.
The account circuit breaker also blocks new authorizations before entering the verification code step, and returns a rejection with `failure.code` as `CIRCUIT_OPEN` and `reason` as `circuit_open`, writing this operation as `locked`.

The circuit breaker lock is partitioned by owner, not by operation or session.
`resolveBreakerOwner` of the [Circuit Breaker](../../security/circuit-breaker.ts) resolves the session to `user:<userId>`.
Therefore another operation on the same account likewise gets `locked: true` in `mfa.verify`.
Both branches—this operation exhausting attempts and the account circuit breaker—write `PendingAction` as `locked`.
The `attemptsUsed` and `maxAttempts` of both branches are taken from the operation's own challenge row.

### Three Forms of Unavailable Challenges

When a challenge cannot be used for verification, the gateway handles it in three ways according to `mfa.challengeInvalidation`.

| Form | Returned Result | Operation Status |
| --- | --- | --- |
| `consumed` | Both `code` and `failure.code` are `CONFLICT`, and `reason` is `denied`. | Written as `cancelled`. |
| `expired`, `command_changed` | Returns the `awaiting_mfa` prompt state, without `code` and `failure`. | Remains `awaiting_mfa`. |
| Cannot be classified | The gateway throws `AppError('CONFLICT')`; the confirmation path converts this throw into a domain result with `code` as `CONFLICT`, and the response is HTTP 200 plus `{ok:false, code:'CONFLICT'}`; only when the throw escapes the confirmation path is it mapped to HTTP 409. | Unchanged. |

A consumed challenge is a settled rejection, not a retryable error.
The gateway writes the operation from `pending` or `awaiting_mfa` to `cancelled` and does not reissue the challenge.
Reissuing would make the user re-verify an already settled decision, so the system does not reissue.
When the status write fails, the gateway re-reads the operation row and performs no business here.

An expired or command-changed challenge can be reissued.
The gateway reissues the challenge and returns `awaiting_mfa`, prompting the user to re-enter the verification code.
Such results do not carry `code` and `failure`, because at this point the user is only being asked to continue verification.
The old verification code submitted in this attempt is not used to verify the new challenge.

When the case cannot be classified, the gateway fails closed: it does not write the operation row, does not provide an entry, and does not create a new challenge.
Such a result only indicates that the operation cannot continue to be confirmed and must be re-initiated.

### Propagation Path of Rejection Fields

Rejection fields travel from the gateway to the web page and WeChat with unchanged meaning.

1. The permission gateway returns `AuthorizationResult.failure`.
2. Settlement writes `locked` as `ToolInvocation`'s `status='failed'` and `errorCode='MFA_LOCKED'`.
3. The web page combines `failure` in the response into a single `security_event` and renders text by field.
4. The WeChat channel renders the reply by the same set of fields.

A lock is a settled state; its tool call ends in failure and does not enter manual review.
Therefore a run containing only lock operations can finish normally.
See [Run Repository](../../lib/db/repositories/agentRun.ts) for the settlement rules.

See [Conversation and Business Cards](chat-presentation.md) for the web page rendering rules.
See [WeChat Channel](weixin.md) for the WeChat reply structure.

### Manual Review Takeover

When the task has open review items, confirmation and verification return a domain rejection rather than an HTTP error response.
The rejected `code` is `MANUAL_REVIEW_HOLD`, and `failure.reason` is `manual_review_hold`.
`failure.actionId` points to the original operation, and `status` remains `pending`; the amount is unchanged.
The interception condition only looks at the task the original operation belongs to and at whether there are still open review items; taking over does not relax any write conditions.
Cancellation does not go through this interception; an explicit cancellation still writes the original operation as `cancelled`.
When this error code escapes the confirmation path, it is mapped to HTTP 409.

During takeover, the only externally facing copy is the single item `chat.error.manualReviewHold`.
That copy states three things: the operation has not yet been executed, it can be recovered from the review inbox, or retry after the review ends.
The "status has changed" copy does not apply: refreshing the page before the review ends will not change the result.
Web chat retrieves the entry via `publicToolError` according to `code`, while WeChat and structured rendering retrieve the entry via `securityNotice` according to `code`/`reason`; both paths land on the same sentence.
Internal English reasons go only into logs and diagnostics, and are not used as externally facing copy.
After the review is closed, reconfirming the original operation is enough to execute it; the amount and payee do not need to be rebuilt.

### Retry paths and state invariants

`locked` is a terminal state; none of the three retry paths writes the operation back to a pending-decision state.

| Path | State result |
| --- | --- |
| Retry the same operation | When verification fails, it remains `awaiting_mfa`; the 3-th failure is written as `locked`. |
| Refresh the page | `GET /api/actions` does not list `locked`, and the page does not render the verification code panel. |
| Recover the plan | `resumePlan` of [lifecycle.ts](../../planner/lifecycle.ts) reads the original result, does not write a row, and does not change the terminal state. |

Read-only recovery refers to `resumePlan`; whether a node can drive is determined by `mayDriveNode` of [executor.ts](../../planner/executor.ts).
When a bare `runPlan` replays the same plan, sealed non-terminal nodes are converged to `failed` by `sealNode` of that file and are no longer driven.

`GET /api/tasks` and `GET /api/tasks/[id]` return `pendingActionStatus` according to the persisted state.
Decisions on locked operations no longer publish `mfa_required` events.
The parking projection during session recovery outputs only `MFA_LOCKED` and `mfa_attempts_exhausted` according to terminal states.
That projection does not distinguish whether the original rejection exhausted this operation's attempts or whether the account circuit breaker was triggered elsewhere.
Recovery, retry, cancel, confirm, and verification return a structured rejection for locked operations.
Execution leases are granted only for the `pending` and `awaiting_mfa` states.
Every write of the `PendingAction` state carries a source-state guard, and `from` is a required source set.
The legal sources are `CLAIMABLE_ACTION_STATUSES` of [action-status.ts](../../agent/action-status.ts), namely `pending`, `awaiting_mfa`, and `confirmed`.
An idempotent backfill that rewrites the same terminal state as itself is also legal; the determination is in `isLegalActionSourceStatus` of that file.
`locked` is never a legal source, and a terminal state cannot be changed to another terminal state either.
When the source guard fails, [claimPendingAction](../../lib/db/repositories/pendingAction.ts) does not write a row and returns `false`.
The caller handles this guard failure according to the current row state that is re-read.

The planner layer uses `sealReason` of [planner/failure.ts](../../planner/failure.ts) to determine the sealing reason.
A lock rejection is recorded as `locked_refusal`, and the operation having left the open state is recorded as `action_not_open`.
Sealed nodes are no longer driven, and an explicit retry does not reset the node to `pending` either.
When sealed, the node converges to `failed`, preserving the original failure fields and operation identifier.

### Unlock and audit evidence

Unlocking only clears the account circuit breaker and the failure count.
The three types of audit each record one kind of fact.

| Audit | Trigger timing | Description |
| --- | --- | --- |
| `MFA_FAILURE` | Every verification code error. | Severity is medium. |
| `CIRCUIT_BREAKER_TRIPPED` | The circuit breaker is triggered for the first time. | Severity is high; repeated triggers are not written again. |
| `SECURITY_RESET` | Restriction is lifted. | Committed in the same transaction as the state change. |

`detail` of `MFA_FAILURE` contains `actionId`, `attempts`, `attemptsLeft`, `maxAttempts`, `decision`, `result`, and `locked`.
The `result` of the 3-th failure is `session_locked`.
`CIRCUIT_BREAKER_TRIPPED` is committed in the same transaction as the circuit breaker state; if the audit fails, the state rolls back.
`SECURITY_RESET` is committed in the same transaction as clearing the circuit breaker; if the audit fails, the unlock rolls back.
`MFA_FAILURE` is written separately and is not in the same transaction as the `PendingAction` state change.
After `POST /api/security/reset` succeeds, the response field `lockedActionsReopened` is always `false`.
Unlocking does not write locked operations back to `pending` or `awaiting_mfa`.
For the unlock gate and cooldown rules, see [Lifting security restrictions](#lifting-security-restrictions).

When the result is unclear, no copy may claim success, failure, or that funds are unchanged.

For the storage and determination of locks, see [Pending confirmation operation repository](../../lib/db/repositories/pendingAction.ts) and [Circuit breaker](../../security/circuit-breaker.ts).

### Prohibited items

The following content must never be used as user-visible copy:

- The `blockReason` internal payload, i.e., the `__SECURITY_BLOCK__` prefix plus structured JSON.
- Raw JSON fragments.
- Exception stacks and error headers.

`blockReason` enters only the model context and internal logs.
For the identification rules and fallback rules, see [External copy consolidation](#external-copy-consolidation).

## Write transactions and commit validation

Business changes, required audits, execution receipts, and related tool call results are committed in the same transaction.
If the audit fails, the business changes also roll back.

Before writing a new change, the system checks the original session's state and owner again.
The originally authorized tool and parameters must remain consistent.
Red operations also require the review verification code's validity period, consumption status, and command digest.
Committed results are read through the original execution receipt.
If the verification code later expires, it does not prevent reading the committed result.

Commit validation checks the following facts:

- The current user and the resource owner are the same.
- The session has not triggered a security circuit breaker.
- The run, session, and node still hold the execution lease.
- The workflow generation and confirmation claim are still valid.
- The explicitly specified plan and node actually exist.

Model parameters and request JSON cannot be injected into the commit validation function. A handler process that has lost execution rights cannot add writes.
After the plan is cancelled or handed off to manual processing, committed transactions still retain their original results.

## Recovery and manual verification

Recovery checks the execution receipt first. The system verifies the user, tool, and command digest; for transfers, it also verifies the actual ledger.
Verified committed facts directly recover the original result.

If recovery might write for the first time, the system rechecks authorization and the current risk. The write transaction checks the circuit breaker again.
Read-only recovery of a verified receipt can complete during a circuit breaker.
When the circuit breaker rejects a new business change, the interface returns `423 CIRCUIT_OPEN`.

When the receipt is missing, corrupted, or contradicts the ledger, the operation enters `needs_reconciliation`.
The system retains the original success audit and writes an additional manual verification audit.
The execution audit uses `exec:<actionId>`; the manual verification audit uses `reconcile:<actionId>`.

When cancelling a plan, the system verifies, within the transaction, the execution receipts of nodes whose states have not yet been written.
Committed operations recover the success state. Operations with insufficient evidence continue to await manual verification.
Cancellation processing does not query results by rerunning bank commands.

For recovery rules, see [Persistence and recovery](agent-durability.md). For manual operations, see [Manual verification](manual-review.md).

## Model capabilities and risk circuit breaker

The model can only call registered tools. The system has not registered the following execution capabilities for the model:

- Shell commands and filesystem access.
- Arbitrary SQL queries and writes.
- Arbitrary HTTP requests.
- Generated code execution.

Tool parameter schemas and the plan compiler limit executable capabilities. Resource privilege escalation uses a 10-minute window.
When 3 signals accumulate within the window, the system locks the account.
Business failures use a 5-minute window; when 5 signals accumulate, the account is locked.
Suspicious instructions only write audit events; they do not accumulate signals and do not lock the account.
Signal identities are deduplicated, so repeated delivery does not increase the count.

Risk signals, events, lock results, and circuit breaker audits are committed in the same transaction.
The circuit breaker state is persisted per user; changing sessions or restarting the process does not lift the lock.
During the lock, the permission gateway rejects new tool calls, including green queries.
Read-only recovery of committed facts does not grant new tool execution rights.
For unlock rules, see [Circuit breaker](../../security/circuit-breaker.ts).

### Lifting security restrictions

The security center provides a runtime unlock entry point, with the interface `POST /api/security/reset`.
When the account is in the locked state, unlocking requires a 6-digit verification code, or waiting for the 60-second cooldown period to end.
When valid verification is missing, the interface returns HTTP 423, and the locked state remains unchanged.
Unlocking only clears the circuit breaker state and the consecutive failure count.
Unlocking does not write locked operations back to `pending` or `awaiting_mfa`.
Unlocking does not automatically execute any original operation, nor does it create new business.
The `lockedActionsReopened` of a successful response is always `false`.
The user must re-initiate and re-confirm in order to handle the same business.
Unlocking only renews the locked challenge that is still in the `awaiting_mfa` operation.
The original operation's identity, receipt, and audit remain unchanged.
Developer mode additionally shows "Reset failure count", handled by `POST /api/developer/security/reset`.
This entry first checks the mode preference; resetting also writes an audit.
Resetting does not approve or execute pending bank operations.
Developer mode is used for demo maintenance and does not constitute production identity authentication.

## Logs and result display

The system internally saves observed Pi events and redacts credentials. Model thinking content is kept only in internal logs.
The conversation interface returns conversation display events.
The operation record interface returns limited business fields.
The technical audit interface requires developer mode to be enabled.

### External copy consolidation

[Public copy](../../lib/public-text.ts) is the only exit.
When internal diagnostics are converted into user-visible text, they may only go through this module.
The only predicate for identifying internal diagnostics is `isInternalDiagnostic`, see [Internal text determination](../../lib/internal-text.ts).
This predicate identifies 4 types of internal diagnostics:

- `__SECURITY_BLOCK__` internal payload.
- Raw JSON fragments.
- Exception stacks and error headers.
- Null-value text such as `undefined`, `null`, `[object Object]`.

`safePublicText` replaces matched text with the entry fallback.
`publicToolError` is provided by [Tool feedback](../../lib/tool-feedback.ts) and is the whitelist for `safePublicText` calls.
`publicToolError` only allows entries, exact business copy, and 3 closed regular expressions.
`securityNotice` reads only the `code`, `reason`, and `attemptsLeft` 3 fields.
The remaining count is interpolated only in the single copy `chat.error.verificationRemaining`.
The only default value for this interpolation is 1 `?? 0`: when `attemptsLeft` is missing, it renders as 0; negative values render as-is.

Both web chat and the WeChat channel render rejection copy through this exit.
Internal markers, raw JSON, and exception stacks must not appear in any user-visible text.
Internal diagnostics are written only to `debugDetail`, developer details, or file logs under `logs/`.

Financial result descriptions are generated from structured results. Plan descriptions cannot prove that an operation has been executed.
When the result is unclear, the displayed content retains the manual verification status.

For the boundaries of production authentication, log encryption, and external bank integration, see [Current limitations](known-risks.md).
