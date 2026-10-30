# Scheduled Tasks and Reminders

**English** | [简体中文](../cn/scheduled-tasks.md)

Scheduled tasks store future intent; when due, they are dispatched by the server. When scheduled payments become due, permissions still need to be checked.

`/schedules` displays task and reminder notifications for the current session.
"Check due tasks" runs 1 round of server checks. The command line uses the same dispatch service.

## Tool Entry Points

The model creates tasks with `create_scheduled_task` and reads tasks with `list_scheduled_tasks`.
`create_scheduled_task` is a YELLOW capability and is only persisted after user confirmation.
`list_scheduled_tasks` is a GREEN read and returns results directly.
Cancellation has no corresponding model tool: `cancelScheduledTask` of `banking-sdk/task.ts` is for server-side invocation only.
See [tool-catalog.ts](../../lib/contracts/tool-catalog.ts) for capabilities and risk levels.

Time is declared by only two parameters: the integer `runAt` (millisecond timestamp) or `runAtLocal`.
The format of `runAtLocal` is `YYYY-MM-DDTHH:mm[:ss]`, with the time zone fixed to Asia/Shanghai.
When a parameter is missing, the format is invalid, the date does not exist, the time has passed, or the two conflict, validation rejects with `VALIDATION`.
Times in the model's prose do not change the declared time.
See [scheduled-time.ts](../../lib/scheduled-time.ts) and [plan-parameters.ts](../../agent/tools/plan-parameters.ts) for the rules.

## Due Behavior

| Type | Due handling | Completion basis |
| --- | --- | --- |
| `REMINDER` | Write a reminder notification | Notification, audit, and task status committed together |
| `TRANSFER` | Save the original payment workflow, then enter the permission gateway | Committed result of the original workflow |
| `PAYMENT` | Process the payment using the demo transfer channel | Committed result of the original workflow |

The current `PAYMENT` has no merchant payment integration.
Payments re-check the payee, amount, balance, cumulative risk, and permissions.
When confirmation or authentication is needed, the task stops at `AWAITING_CONFIRMATION`.
The user handles the original pending-authorization operation in the AI assistant.

The saved `requiresConfirmation` cannot exempt the due-time permission check.
This field is derived by the server by type: `false` for reminders, and `true` for payments and transfers.
Repeated dispatch reuses the original workflow and original authorization, and does not create duplicate payment entries.
The background does not automatically advance workflows that are pending confirmation, pending authentication, or manually paused.
The due check only continues original workflows in the `pending` and `running` states.
While a manual review is in progress, `/确认`, `/验证`, and `/取消` return a domain rejection.
For this rejection, `code` is `MANUAL_REVIEW_HOLD` and `failure.reason` is `manual_review_hold`.
The copy renders only `chat.error.manualReviewHold`: the operation was not executed; recover from the review inbox or wait for the review to end.
The generic "business status has changed" copy does not hold here, because refreshing does not lift the review.
A locked operation is terminal: it is no longer dispatched, no longer retried, and will not come back to life.
Once a stop-and-wait node is settled, it is sealed, and subsequent checks no longer drive that node.
Retrying a sealed node is rejected in a structured way: `locked` returns `MFA_LOCKED`, and other terminal states return `CONFLICT`.

Tasks pending a manual decision do not occupy new dispatch capacity. Subsequent due tasks can still be dispatched.
The only dispatchable states are `SCHEDULED` and `DISPATCHING`; completed decisions no longer occupy capacity.
By default, 25 tasks are checked per round per user and session scope, with an upper limit of 100 tasks.

## Task States

| State | Meaning |
| --- | --- |
| `SCHEDULED` | Saved, not yet dispatched |
| `DISPATCHING` | Original workflow saved, being processed |
| `AWAITING_CONFIRMATION` | Waiting for user confirmation or authentication |
| `DONE` | Reminder delivered, or payment workflow succeeded |
| `FAILED` | Clear failure in parameters, identity, or workflow |
| `CANCELLED` | Future execution cancelled |

Reminders go directly from `SCHEDULED` to `DONE`.
Payments typically pass through `DISPATCHING` and `AWAITING_CONFIRMATION`.

If a temporary infrastructure failure occurs before the workflow is created, the task retains `SCHEDULED`.
The system saves the error, and subsequent checks can retry.
Once the workflow has started, results and authorization continue to be managed by the original workflow.

Reminder notifications and required audits are committed in the same transaction.
If the audit fails, the transaction rolls back, and subsequent checks can redeliver.
The unique constraint on the notification table prevents duplicate delivery of the same reminder.

## Cancellation and Input Boundaries

Intent that has not yet been dispatched can be cancelled directly.
A dispatched payment must be cancelled through its owning plan.
Cancelling the plan revokes unexecuted authorizations and retains committed transactions.
When an active workflow exists, the bank SDK refuses to directly cancel the scheduled intent.
The cancellation condition is that `dispatchTaskId` is empty and the state is still `SCHEDULED`.

Payment parameters accept only an explicit payee and a valid amount.
Arbitrary tool names, executable code, and verification codes are rejected before the workflow is created.
[scheduled-command.ts](../../lib/contracts/scheduled-command.ts) is called to validate these fields both before creation and before dispatch.

## Clock and Sessions

Creation validation, public HTTP due checks, and command-line default checks use the same business clock, `demoNow()`.
Requests cannot supply `now`, a user ID, or a session ID.
The server uses a fixed demo identity and verifies the session the task belongs to.
One session cannot read or dispatch another session's tasks.

Preset tasks may not yet be bound to a session. An authenticated page check can establish the source-session binding.
The command line only traverses tasks with a saved source session.

Demo fast-forward is explicitly specified by the trusted command line:

```sh
pnpm scheduler:tick --now '2099-11-20T09:00:00+08:00'
```

Scheduling fast-forward can trigger future intent. Authorization and authentication still expire according to real time.
The demo clock cannot extend the authentication validity period.
Time validation at creation compares against the demo clock: `runAt` must be later than `demoNow()`.
The default business time is fixed at Beijing time `2026-09-25 12:00`; real waiting does not advance business time.
The command-line `--now` can explicitly advance the dispatch time for this round without modifying the saved task time.
Business day and business month boundaries are fixed at UTC+08:00 (`Asia/Shanghai`).
Security expiration, leases, and cooldowns use real time.

## Deployment Entry Point

Each command execution runs 1 round of checks and then exits:

```sh
pnpm scheduler:tick
```

A process manager or external scheduling service can invoke the command periodically.
The system does not implicitly start the scheduling loop when the Web service starts.
The actual execution time of tasks depends on check frequency and process availability.

## Interfaces and Code Entry Points

The scheduled tasks page shows task status and notifications.
The page does not provide a unified "go to confirm" redirect.
Pending actual bank operations remain in the original AI conversation.
Checking due tasks does not replace user confirmation or authentication.

| Interface or module | Responsibility |
| --- | --- |
| `GET /api/schedules` | Reads the current session's tasks and the most recent 100 notifications |
| `POST /api/schedules/tick` | Accepts the empty object `{}` and performs a real-time check |
| [Dispatch service](../../agent/scheduled-dispatcher.ts) | Identity scope, atomic dispatch, and workflow state synchronization |
| [Command-line entry point](../../scripts/scheduler.ts) | Traverses bound sessions and performs bounded checks |
| `ScheduledTask.dispatchTaskId` | Associates the unique original payment workflow |
| `ScheduledNotification.scheduledTaskId` | Prevents duplicate notifications via a unique constraint |
| [Scheduled task tools](../../agent/tools/task.ts) | Parameters and results of `create_scheduled_task` and `list_scheduled_tasks` |

Birthday purchasing uses budget quotas, future intent, and reminders. The system does not actually buy flowers or cakes.
Budget quotas do not freeze withdrawable funds, and scheduled payments do not deduct funds in advance.

[Distribution interface tests](../../tests/app/scheduled-dispatch-http.test.ts) check concurrent delivery, audit rollback, and re-authorization.
The cases also check cross-session rejection, cancellation after dispatch, and illegal payloads.
See [Persistence and Recovery](agent-durability.md) for process recovery rules of the scheduling workflow.
