# Banking Tool Contract

**English** | [简体中文](../cn/tool-contracts.md)

Banking tools accept only explicit parameters and return structured facts or errors.
The model understands the conversation; the security gateway decides whether a transaction can be processed.
Tool results cannot be replaced by natural-language success declarations.

## Execution Entry Point

Tool names and permission definitions come from the [tool catalog](../../lib/contracts/tool-catalog.ts).
The [registry](../../agent/tools/index.ts) binds the user identity provided by the server.
The model cannot provide user identity, execution leases, or idempotency keys.
Card deletion is only available on the card management page; the model has no deletion tool.
Virtual cards can be requested from the card page or by the agent.
The system has no password credentials and no password change tool.

Each model call goes through the following checks in order:

1. Call IDs in the same model reply are non-empty and unique.
2. Raw parameters conform to the public schema, with no implicit type conversion.
3. This round's declaration permits proposing that capability.
4. The gateway checks the owning user, risk level, and authorization status.
5. The write transaction checks execution rights and saves the business result and receipt.

Different model replies can reuse a call ID.
The run ID, model request ID, and call ID together identify a call.
Workflow nodes use a server-generated execution identity.

## This Round's Declaration and Information Completeness

The model declares via `describe_turn` the purpose, capability sequence, and `needsInput`.
When the processing purpose does not provide `needsInput`, the server treats it as `true`.
`true` indicates that the processing target, amount, or other required selections still need to be supplied.
This state permits prerequisite queries but rejects write tools and `submit_plan`.
The server retains the clarification and does not add a request to choose a card on the user's behalf.

Once the prerequisite queries determine the target, the complete write sequence of the original request can continue to be declared.
Once the write sequence is bound, the purpose, sequence, or information completeness cannot be changed.
`needsInput:false` only indicates that the model considers the information complete; it does not represent user authorization.
Confirmation, verification codes, owning user, and transaction checks continue to execute independently.
For the trigger and recovery rules of a single continuation, see [Persistence and Recovery](agent-durability.md#single-continuation-for-declared-writes).

## Parameters and Errors

Missing required parameters, unknown fields, and wrong types all report `VALIDATION`.
Amount parameters are decimal text without signs or exponents, with at most 2 decimal places.
Share parameters have at most 6 decimal places, and net value parameters have at most 4 decimal places.
Amount parameters other than spending limits must be greater than 0.
Spending limits allow 0.
Raw parameters are validated before Pi type conversion.
All nodes are validated before plan submission; parameters are not supplemented after execution begins.

Resources that do not exist or do not belong to the current user all report `NOT_FOUND`.
Selected resources must use real business IDs.
Card tools share the `cardId`, `cardType`, `cardTail`, and `cardNumber` selectors.
Writing the last digits or the full card number into `cardId` is rejected and will not be queried as an id.
When a selector cannot be uniquely resolved, it reports `VALIDATION` and returns a masked clarification.
Search terms are used to return candidates and cannot prove execution identity.
Fuzzy contact matches report `CONFLICT` and return safe candidates.

| Error code | Model's subsequent handling |
| --- | --- |
| `VALIDATION` | Correct the parameters or ask for the missing information. |
| `NOT_FOUND` | Query available objects and ask the user to select again. |
| `INSUFFICIENT_FUNDS` | Explain insufficient funds; do not change the account or lower the amount on your own. |
| `LIMIT_EXCEEDED` | Explain the limit; do not split transactions to circumvent the limit. |
| `SECURITY_DENIED` | Explain the capability or permission limitation; do not bypass the gateway. |
| `MFA_FAILED` | Use the existing verification interface; do not request credentials in chat. |
| `MFA_LOCKED` | Explain that the operation is locked; do not retry or re-verify. |
| `CIRCUIT_OPEN` | Handle the lock through the secure interface. |
| `MANUAL_REVIEW_HOLD` | Explain that this attempt was not executed; ask the user to resume from the manual review entry point or wait for the review to finish. |
| `CONFLICT` | First verify the current object or the saved processing status. |
| `TOOL_FAILED`, `INTERNAL` | First verify the execution record; do not directly resubmit the write or claim success. |

The top-level `code` for lock rejections is always `CIRCUIT_OPEN`.
When the verification codes for this operation are exhausted, `failure.code` reports `MFA_LOCKED`.
The corresponding reason is `mfa_attempts_exhausted`.
When an account circuit breaker is triggered elsewhere, `failure.reason` is `circuit_open`.
When resubmitting an already locked operation, `failure.reason` is `mfa_session_locked`.
The `code` for manual takeover rejection is `MANUAL_REVIEW_HOLD`.
Its `failure.reason` is `manual_review_hold`.
That rejection renders only `chat.error.manualReviewHold`.
That rejection means this attempt was not executed; recovery must come from manual review or waiting for the review to finish.
For structured failure fields and copy ownership, see [Permissions, Authentication, and Audit](security.md).
Internal markers are recognized by [`isInternalDiagnostic`](../../lib/internal-text.ts).
Public text is output only through [external copy consolidation](../../lib/public-text.ts).
Error codes come from the business contract and are not extracted from error text.
Internal SQL, file paths, and raw infrastructure exceptions are not given to the model.
The model's next-step hint does not grant retry permission.
Automatic recovery still requires verification of the receipt, execution rights, and retry budget.

## Query Tools

An empty result set from a query is a success and does not mean the tool failed.
Incorrect filter conditions cannot be ignored to broaden the query scope.

| Tool | Input boundaries and result meaning |
| --- | --- |
| `get_balance` | Returns the owning user's deposit accounts and query balances; account numbers are masked. |
| `get_transactions` | Timestamps are integers, and the range uses `[from, to)`; requires `from < to`. `category` takes exact spending categories. Defaults to the most recent 50 records, up to 200 records. Income and expense totals cover only the returned records. |
| `search_contact` | The query text must be valid text; returns candidate contacts and business IDs. |
| `search_conversation_history` | Queries the raw text of the current session; `query` is 1 to 256 characters long, `limit` takes 1 to 20, `beforeIndex` is not less than 0. Missing trusted session identity reports `SECURITY_DENIED`. Historical text does not represent current authorization. |
| `analyze_spending` | `month` uses a valid `YYYY-MM`, defaulting to the current banking business month; returns spending statistics for the full month. |
| `detect_anomaly` | Returns screening flags and corresponding transactions; cannot prove chargeback or refund eligibility. |
| `get_cards` | Returns the owning user's cards, statuses, category limits, and monthly limits; card numbers are always masked. For field definitions of linked status and available balance, see [Card Management](card-management.md). |
| `list_subscriptions` | Yellow query; after confirmation returns active subscriptions; query confirmation cannot replace cancellation confirmation. |
| `list_investments` | Risk levels accept only `R1` to `R5`; unmatched products return an empty set. |
| `compare_investments` | The product set cannot be empty; if any ID does not exist, an error is reported rather than comparing only the remaining items. Duplicate IDs are deduplicated. |
| `get_investment_holdings` | Returns the owning user's holdings; shares retain 6 decimal places, and net values retain 4 decimal places. Remaining cost is listed separately, and market value is derived as shares × latest net value without rounding. Holdings also include net value date, returns, cumulative returns, most recent purchase time, and purchase records; when shares or net values are missing, valid historical valuations are retained and marked "to be verified"; only when there is no historical valuation does it fall back to cost. |
| `get_dashboard_summary` | Returns snapshots of assets, spending, and transactions; credit card available credit is not counted in deposit assets. |
| `list_scheduled_tasks` | Returns the owning user's task status and plan parameters; internal dispatch diagnostics do not enter model data. |

Months use the banking business time zone.
The financial calendar preserves literal year values rather than interpreting years 0–99 as 1900–1999.
Queries spanning pages or limited by record counts cannot masquerade as complete monthly statistics.

## Write Tools

| Tool | Authorization and execution boundaries |
| --- | --- |
| `transfer_money` | Yellow or red is determined by amount and daily cumulative amount: if neither exceeds 1000 yuan, it is yellow; if either exceeds, it is red. `amount` is required; the payee is specified using one of `contactId`, `phone`, or `name`; the payment account can be given as `sourceAccountId`. Insufficient balance, insufficient limit, wrong account, and invalid amount report errors. |
| `set_card_limit` | Yellow; `category` and `amount` are required. Categories come from the official catalog, and only normal or frozen cards are processed. Only one limit is retained per card per category. A reported-lost card reports a conflict. |
| `freeze_card`, `unfreeze_card` | Red; status is reread within the transaction. The same status can be returned idempotently; conflicting statuses cannot be overwritten by an old snapshot. |
| `report_lost_card` | Red; verifies the owning user, current status, and reason for loss report. Loss reporting is a terminal state; repeated loss reporting reports `CONFLICT`. |
| `apply_virtual_card` | Red; requests a virtual card, with an optional monthly limit. The monthly limit has cent precision and must not be negative. Replaying the same execution key returns the original card. |
| `consume_virtual_card` | Red; debits from the demand deposit account bound to the virtual card; the posting time is determined by the server's business clock. Does not accept caller time fields such as `occurredAt`, `bookedAt`; if present, reports `VALIDATION` and does not debit. The spendable amount is the lesser of the account's available cash and the remaining monthly limit; the monthly limit is combined across cards before and after replacement. When the card is not in a normal state, or the linked status is `MISSING` or `UNTRUSTED`, reports `CONFLICT`. Exceeding the monthly limit reports `LIMIT_EXCEEDED`; insufficient balance reports `INSUFFICIENT_FUNDS`. Replaying the same execution key returns the original spending record. |
| `replace_card` | Red; only replaces reported-lost cards; the original card remains `LOST`. Other statuses report `CONFLICT`. |
| `cancel_subscription` | Yellow; cancels by `subscriptionId`; after cancellation, reminders are closed; the same already-cancelled state can be returned idempotently. |
| `set_subscription_reminder` | Yellow; sets the boolean `remind` by `subscriptionId`; cancelled subscriptions cannot modify reminders. |
| `reserve_budget` | Green; `name` and `amount` are required; `purpose` and `dueDate` are optional. Only creates bookkeeping budgets; does not freeze, deduct, or transfer account funds. |
| `create_scheduled_task` | Yellow; `name` and `kind` are required; `kind` takes `REMINDER`, `PAYMENT`, or `TRANSFER`. Time uses integer `runAt` or local time `runAtLocal`, such as `2026-10-15T09:00`. Reminder payloads contain only text; payment payloads must have a unique payee selection and a positive amount. |
| `subscribe_investment` | Red; verifies product, minimum investment amount, payment account, and balance. The server converts the purchase amount into shares at the latest net value, rounding down to 6 decimal places. If the product is already held, it is merged into the original holding: remaining cost increases by this amount, and shares increase by the converted shares. If the product has no published net value or is below the minimum investment amount, reports `VALIDATION`; insufficient balance reports `INSUFFICIENT_FUNDS`; missing available shares in the holding reports `CONFLICT`. |
| `redeem_investment` | Red; `mode` must be explicitly provided, with value `SHARES`, `AMOUNT`, or `ALL`; there is no default basis. `SHARES` requires `shares`; `AMOUNT` requires `amount`; `ALL` does not accept shares or amount. Missing, unknown, mixed bases, or the presence of `redeemAmount` all report `VALIDATION` as a clarification. When the confirmation snapshot is inconsistent with the latest holding or net value, fails with `CONFLICT` and performs zero writes; replay under the same identity still returns the original receipt. |

Public results for investment purchases and redemptions include the post-operation balance.
Purchases return `subscribedShares`, `totalShares`, and `lastPurchaseAt`.
Additional purchases also include `addedToExisting`, indicating it has been merged into the original holding.
Redemptions return `mode`, `redeemedShares`, and the execution net values `netValuePerUnit`, `netValueDate`.
Redemptions also include `redemptionValuation` and `settlementRounding`.
When `partial` is `true`, the result also includes `remainingShares`, `remainingCost`, `remainingMarketValue`, and `remainingProfit`.
`realizedProfit` is the credited amount minus the cost consumed by this transaction and can be negative.
`redeemedPrincipal` is the cost consumed by this redemption, not the redemption principal.
`remainingPrincipal` has the same value as the remaining cost `remainingCost`.
`feeAmount` is always `0.00`, and `feeRule` is always `SIMULATED_NONE`.
For precision and fee definitions, see [Wealth Management Net Values and Shares](investments.md).
After the investment write completes, the result includes a holding projection `holdings` reread after submission.
If the reread is unavailable, omit this field and do not roll back the committed write.

Write idempotency keys come only from server execution options.
The same key must match the same user, tool, and parameter digest.
An existing receipt returns the original result first; funds cannot be modified again.
The same status does not mean different commands can share a receipt.

Scheduled reminder delivery due does not require banking processing confirmation.
Scheduled payments and transfers still require confirmation or strong verification when due.
`requiresConfirmation` is generated by the server and cannot be set by the model.
Creating a scheduled task cannot pre-approve future payments.

`submit_plan` validates the task graph first, then registers all nodes.
Dependencies, conditions, output references, and the declared write sequence must be consistent.
Node IDs must be a single path segment, containing no dots, parentheses, whitespace, or control characters.
`__proto__`, `constructor`, and `toString` can be referenced as ordinary node names.
The execution result table uses prototype-less objects and does not read results through prototype properties.
Each sensitive node is authorized separately; confirmation of a previous node cannot authorize the next node.
A failed plan still retains the results of nodes that already succeeded.
A plan is not a global atomic transaction across businesses.

## Saved Information for the Model and the Interface

Pi sends `content` to the model.
`details` and `structuredContent` are for the interface and programs.
Putting data only into `details` will make the model unable to see the complete business facts.

The [result adapter](../../agent/tools/result.ts) uniformly generates tool results:

- Successful content contains two text segments: a summary and `{ ok: true, data }`.
- Failures use Pi's native `isError: true`.
- Failure content contains `bankingError`, which includes `code`, `message`, and `nextAction`.
- `bankingError.retryable` is always `false`.
- Failed plans retain node results and cannot be displayed as overall success.
- Business IDs, financial values, and archived original text remain complete.
- User internal identities, execution keys, leases, and dispatch diagnostics are not sent to the model.
- Phone numbers and credentials are masked in model data.

The interface uses an independent card projection and displays only real business results.
Developer mode can view call parameters and execution records.
Confirmed queries also use the same model result adapter.
The model can continue from the original question and read the object IDs in the completed query.

Logs save complete tool content, structured results, and available latency and usage.
Recovery cannot rebuild only the first summary segment.
Incomplete parameter fragments may contain credentials, so the fragments retain only redacted events.
The completed call parameters are still saved and redacted by field.
For recovery rules, see [Persistence and Recovery](agent-durability.md).

## Code and Verification Entry Points

- [Tool parameter validation](../../agent/tools/plan-parameters.ts).
- [Model result contract tests](../../tests/unit/planner/model-tool-result.test.ts).
- [Write boundary tests](../../tests/integration/write-domain-boundaries.test.ts).
- [Duplicate call identity tests](../../tests/integration/tool-call-identity-boundary.test.ts).
- [Tool module maintenance notes](../../agent/tools/CONTEXT.md).
