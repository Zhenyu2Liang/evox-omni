# Manual Review

**English** | [简体中文](../cn/manual-review.md)

`/manual` provides a demo entry point for bank backend reconciliation in developer mode.
The handler can pause automatic progression, record notes, and decide on subsequent processing.
Manual notes do not modify balances or fabricate transactions.

User confirmation and manual review are different flows:

| Flow | Role | Purpose | Entry |
| --- | --- | --- | --- |
| User confirmation | Bank business user | Review operation details and confirm or enter a verification code | Operation card in the original conversation |
| Manual review | Simulated backend reviewer | Handle workflows that failed or have unknown results | "Manual Review (Demo)" in developer mode |

Currently, no bank customer service is connected, and there is no independent employee login.
The same demo user plays the backend reviewer in developer mode.
The manual review entry is not shown on regular user pages.
Manual review cannot replace user confirmation or authentication.

## Processing Flow

1. Enable developer mode and open "Manual Review (Demo)".
2. Select a task or standalone operation.
3. Fill in the reason for escalation to manual handling.
4. Submit the takeover request.
5. Wait for in-flight commands to reach a safety checkpoint.
6. Fill in the review notes.
7. Select a processing conclusion.

Task candidates include pending execution, running, paused, pending confirmation, and failed states.
Standalone operation candidates include operations with a clear failure result and operations that require manual review.
The reason must be 5 to 1000 characters, and the conclusion notes must be 5 to 2000 characters.

The takeover request is saved immediately. A running plan enters the paused state.
Commands that had already obtained execution rights may complete, and their original execution receipts are saved.
After takeover, the system stops claiming successor nodes and new authorized executions.
New `confirmed` claims are rejected during the review period; commands already started retain their original claims and receipts.
When a task has an open review item, confirmation and verification return a domain rejection, and the original operation remains `pending` with the amount unchanged.
Explicit cancellation bypasses this interception and still writes the original operation as `cancelled`.
For the error code, structured fields, and external wording of this rejection, see [Manual Review Takeover in the Security Topic](security.md#manual-review-takeover).

## Takeover States

| State | Meaning | Available Actions |
| --- | --- | --- |
| `human_review_requested` | In-flight commands have not yet finished | Wait for the safety checkpoint |
| `operator_controlled` | The system has stopped automatic progression | Record notes and select a conclusion |
| `resolved` | The manual record has been closed | View the processing conclusion |

The server calculates the takeover state and button permissions. Hiding page buttons cannot replace server-side checks.

## Processing Conclusions

| Conclusion | Conditions | Result |
| --- | --- | --- |
| `stop` | In-flight commands have finished | Cancel unexecuted steps and unexecuted authorizations |
| `resume` | The task is paused or pending confirmation, and there are no failed nodes or unknown results | Release manual control, retaining the original graph and original authorization |
| `retry` | The task failed, and there is clear evidence of non-submission | Retry the failed node and its dependent nodes |

Successfully completed nodes and posted transactions are always retained.
After resuming a task pending confirmation, the user still needs to decide on the original operation.
Authorization expiration, authentication expiration, and risk escalation are handled according to current security rules.

A failed write node must have a clear failure result. Retry is allowed only after the system verifies that there is no submission receipt.
Pending confirmations, active executions, submitted results, and unknown results all block retry.
Retrying a write node still goes through the confirmation and authentication flow.

`needs_reconciliation` indicates that the financial result is unknown. The handler can only record notes and end automatic processing.
After the manual record is closed, the financial operation still retains the manual review state.

If the requirement changes to adjusting the amount or payee, the user initiates a new request.
Manual notes cannot modify the original authorization. Executed transactions do not provide automatic reversal.

## Persistence and Auditing

`ManualReview` saves the following:

- The owning user, session, and handler.
- The associated task or standalone operation.
- The reason, notes, and processing conclusion.
- Creation time, processing time, and record state.

The `activeKey` unique constraint ensures that a target has only one active record.
Takeover and conclusion audits are saved separately, and the audit and state change share a transaction.
If the audit fails, that processing is rolled back.

Concurrent processing claims records through conditional updates. Later requests cannot overwrite a saved conclusion.
Workflows and confirmation executions claim checks against active manual records. In-flight executions retain their original claim identity.

## Interfaces and Code Entry Points

| Interface or Module | Responsibility |
| --- | --- |
| `GET /api/manual-reviews` | Query candidates and processing records for the current session |
| `POST /api/manual-reviews` | Submit `taskId` or `actionId` and the reason |
| `POST /api/manual-reviews/[id]` | Submit `stop`, `resume`, or `retry` and the notes |
| [Manual Processing Business](../../agent/manual-review.ts) | Ownership checks, persistence, and transactional auditing |
| [Takeover Policy](../../agent/manual-review-policy.ts) | Safety checkpoints and processing permissions |

The interfaces use a fixed demo identity and verify user and target ownership.
The manual processing interfaces are not registered as model tools.
The current handler comes from the same demo session.
Both the page and the manual review interfaces check developer mode.
The mode switch only controls demo tools and does not provide production employee authentication.

## Verification Entry Points

[Interface Tests](../../tests/app/manual-review-http.test.ts) cover real routes, the database, and the executor.
Test cases check takeover persistence, authorization retention, concurrent decisions, and audit rollback.
Test cases check that confirmation during the review period returns a domain rejection, the original operation remains `pending`, and the amount is unchanged.
Test cases also check that an in-flight financial result is submitted only once, and that successor nodes stop progressing.

In browser acceptance, `g-manual-handoff` checks takeover, refresh, and processing conclusions.
The browser uses preset failures and unknown results and does not create process crashes in this journey.
For execution commands, see [Test Instructions](test-cases.md).
