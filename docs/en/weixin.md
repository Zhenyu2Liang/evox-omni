# WeChat Channel

**English** | [简体中文](../cn/weixin.md)

The WeChat channel uses the iLink protocol module of `pi-weixinbot@1.0.5`.
The channel hands text messages to the existing Wanxiang Cabinet Bank agent HTTP interface.
Models, business permissions, confirmation, verification codes, audit, and receipts reuse the Web flow.
No need to install or run OpenClaw.

## Startup

First prepare the application according to the [Development Guide](development.md).
If an existing demo database is present, there is no need to reseed.
The model mode is determined by the bank service's configuration.
When using a real model, configure `.env.local`, the model, and the key in `LLM_MODE=live`.

In terminal 1, start the bank service:

```sh
pnpm dev
```

In terminal 2, log in to WeChat, then start the message-receiving process:

```sh
pnpm weixin:login
pnpm weixin:start
```

Scan the terminal QR code with WeChat and confirm on your phone.
Save the QR code image as `logs/weixin-login.png`.
The message-receiving process starts only after the login command completes.
The startup information shows the `live` or `mock` mode actually used by the bank service.

Open the bot conversation in WeChat and send "查询我的活期账户余额" (Query my checking account balance).
After receiving a reply normally, test businesses that require confirmation.
First login, WeChat client compatibility, and real message sending and receiving require phone participation.
Obtaining a QR code does not mean WeChat connectivity has been completed.

## Confirmation and Verification

You can directly query or make business requests in natural language.
Operations awaiting confirmation are displayed one at a time with their details.
After checking the amount, payee, and risk level, use explicit commands:

| Command | Purpose |
| --- | --- |
| `/帮助`、`/help` | View channel commands |
| `/待办` | Show the pending operations and real status of the current demo account |
| `/确认` | Confirm the currently displayed operation |
| `/验证 六位验证码` | Submit the verification code for the currently confirmed operation |
| `/取消` | Cancel the currently displayed operation |
| `/确认 操作编号` | Confirm the specified operation; red operations continue to wait for a verification code |
| `/验证 操作编号 六位验证码` | Submit the verification code for the confirmed red operation |
| `/取消 操作编号` | Cancel the specified pending operation |
| `/恢复操作 操作编号` | Request the server to verify and restore the original operation without creating a new business |
| `/任务` or `/任务 任务编号` | View multi-step tasks, node statuses, and associated confirmation entry points |
| `/暂停 任务编号`、`/继续 任务编号` | Control the execution of multi-step tasks |
| `/重试 任务编号`、`/取消任务 任务编号` | Retry a failed task or cancel subsequent steps |
| `/回退记录 任务编号` | Withdraw revocable budgets and scheduled records; does not withdraw posted transactions |
| `/定时任务`、`/检查到期` | View plans and notifications, or perform a real-time expiry check |

After checking the current operation, send `/确认` directly.
When a verification code is required, then send `/验证 123456`.
Here `123456` is only a command example; the actual verification code is determined by the verification flow.
Multiple operations are displayed one by one in queue order, and each is confirmed separately.
After the current operation is completed or cancelled, the details of the next operation are displayed, waiting for confirmation again.
Operations requiring a verification code stop at the current step and continue only after verification passes.
The current operation and queue order are preserved after a restart.
If the current operation has already ended on the web page, the next operation is displayed first and will not be directly confirmed.
Send `/待办` to view the current operation and remaining count again.

Compatible commands with short numbers or full numbers are still supported, for example `/确认 1`.
Each short number permanently points to the original operation and remains unchanged after a restart.

"Confirm" in ordinary chat does not constitute execution authorization.
Verification code commands are not forwarded to the model, and the message body is not saved.
The channel only allows confirming operations whose details have been displayed to the bound user.
Wrong verification codes, cumulative risk escalation, and circuit breaking are still handled by the bank service.
For simulated verification codes and bank function boundaries, see the [Project README](../../README.md).

### Verification Failure and Lock Replies

Replies are generated only from the server's authoritative fields: `status`, `code`, and `failure`.
The first paragraph is always the status block, stating the operation status.
The examples below use the numbered compatible format; current queue operations show only the status.

On the 1、2 incorrect verification code, the operation remains `awaiting_mfa`.
At this point the reply retains the verification entry and gives the remaining count:

```text
操作编号：A-1001
状态：等待验证码
继续验证：/验证 A-1001 六位验证码

验证码错误。还可尝试 2 次。
```

After the 3 incorrect attempt, the operation enters the locked terminal state.
The lock reply is fixed as 4 paragraphs:

```text
操作编号：A-1001
状态：已锁定

该操作已锁定，无法继续验证或执行。原因：验证码错误次数已达上限。请在安全中心解除限制后重新发起操作。

当前状态：该操作已锁定，不再提供验证码入口，也不会执行。

解除方式：请在网页安全中心解除限制；解除后需要重新发起这笔操作，系统不会自动执行原操作。
```

These 4 paragraphs are, in order, the status block, the lock entry, the entry revocation explanation, and the unlocking method.
If the same reply also has event or task text, it is appended as the 5 paragraph.

`继续验证：/验证 …` appears only when the status is `awaiting_mfa`.
The lock reply does not include this line and does not imply that the verification code can be submitted again.

When attempts are exhausted, the top-level `code` is still `CIRCUIT_OPEN`.
The specific reason is represented by `MFA_LOCKED` of `failure.code` and `mfa_attempts_exhausted` of `failure.reason`.
`failure` carries `attemptsUsed`, `attemptsLeft`, and `maxAttempts` at the same time.
Only `attemptsLeft` enters the remaining-count wording.
For field meanings, see [Security Design](security.md#structured-security-failures).

Sending `/确认`, `/验证`, `/取消`, or `/恢复操作` to a locked operation all return the lock structure from the server.
At this point `code` is `CIRCUIT_OPEN`, and `failure.reason` is `mfa_session_locked`.
WeChat renders "安全验证已锁定。请在安全中心查看状态。" (Security verification is locked. Please check the status in the Security Center.), and no verification code entry appears.
If the account is already circuit-broken and this operation is not yet locked, the server returns `circuit_open` and locks the operation at the same time.
WeChat also renders this prompt.

`/待办` no longer lists locked operations.
Locked operations do not create new verification code challenges and do not execute business.

While manual review is in progress, `/确认`, `/验证`, and `/取消` return a domain rejection.
At this point `code` is `MANUAL_REVIEW_HOLD`, and `failure.reason` is `manual_review_hold`.
WeChat renders only `chat.error.manualReviewHold`: the operation has not been executed and must be restored from the review inbox or wait for the review to end.
This state does not use the generic "business status has changed" wording, because refreshing will not lift the review.

### Retry and Resend

If `/验证` is sent repeatedly while the operation is still `awaiting_mfa`, the same verification code challenge is reused.
The remaining count follows the original record and is not reset.
When the challenge expires or the operation parameters change, the server reissues the verification code and resets the remaining count.
At this point the status block still shows waiting for verification code, with `继续验证：/验证 编号 六位验证码` appended.
The security prompt that follows uses the `chat.display.safetyHint` entry, whose content prompts for entering a 6-digit demo verification code.
The reply does not assert that verification has been regenerated.

If a locked operation is redelivered or the message is refreshed, the reply is still the lock structure.
The locked state does not return to `pending` or `awaiting_mfa`, nor does it rebuild the verification code challenge.

When a task stops at a locked operation, `/继续` and `/重试` are rejected by the server.
The rejection is returned through the HTTP 423 error channel, in the form of `服务端提示（MFA_LOCKED）：…` plus the sentence "请核对操作记录后处理。" (Please check the operation record before proceeding.).
This type of rejection does not use the 4 paragraph structure of the lock reply above.
The rejection occurs before any state write, and the task state remains unchanged.
The locked node will not be executed again.

### Revocation of the Verification Code Entry

The server's security rejection event revokes the confirmation and verification entries for that operation.
After revocation, subsequent replies no longer show confirmation or verification prompts for that operation.
Settled operations likewise no longer display confirmation or verification entries.
Revocation affects only the WeChat-side display and does not modify server state.

### Public Wording

WeChat does not assemble security wording itself.
All rejection and failure prompts are handed to [Public Wording](../../lib/public-text.ts) via `channelText` of `channels/weixin/presentation.ts`.
`securityNotice` only selects entries based on server fields.
`blockReason`, `__SECURITY_BLOCK__` payloads, raw JSON, and exception stacks do not enter WeChat messages.
For determination rules, see [Security Design](security.md#external-copy-consolidation).

### WeChat Behavior After Lifting Restrictions

For the unlocking entry and rules, see [Security Design](security.md#lifting-security-restrictions).
Unlocking only clears the account circuit breaker and failure count; the original operation remains locked.
In a successful response, `lockedActionsReopened` is always `false`.
Unlocking does not issue a new verification code entry for locked operations, nor does it extend their verification code challenge.
After lifting restrictions, the same business must be initiated again and reconfirmed on the web page or WeChat.

Web and WeChat share the fixed demo account and conversation.
Operations initiated in WeChat can be viewed and handled on the web page.
Pending operations initiated on the web page can first be viewed via `/待办`.
Only after checking the displayed details can WeChat commands be used to confirm.
Records in progress or pending verification are not described as "not yet executed," nor do they show duplicate confirmation entries.
Unknown results only prompt for verification and do not claim success or that funds are unchanged.
After a task is controlled on the web page or WeChat, the next round of conversation reads the current task status.
Waiting statuses in historical messages cannot replace the current cancelled or paused status.

## Business Coverage

Natural language requests use the same set of banking tools.
Structured cards are converted into WeChat text and do not rely on the model to narrate again.

| Business | Interactions supported in WeChat |
| --- | --- |
| Accounts, contacts, bills | Balances, transactions, spending categories, abnormal transactions, and asset overview |
| Transfers | Initiate by contact or mobile number, check details, confirm or verify according to actual risk |
| Wealth management | Product lists and comparisons, holdings (units, latest net asset value, holding market value and returns), subscriptions, full or partial redemptions, and settlement receipts |
| Cards | Status and limit queries, categorized spending limits, temporary card locking and unlocking, formal loss reporting and replacement |
| Virtual cards | Application, linking to a checking account, spending; the balance is the cash in the linked checking account, and the payable amount is the lesser of the account's available cash and the remaining monthly limit |
| Subscription auto-debits | Query, enable or disable renewal reminders, cancel subscriptions |
| Budgets | Register budgets and display the record boundary "不冻结资金" (does not freeze funds) |
| Multi-step tasks | Plans, node statuses, confirmation entries, pause, resume, cancel, retry on failure, and record rollback |
| Scheduled tasks | Create, query, check expiry, read reminder notifications, and handle expiry payment confirmations |

Scheduled checks follow the web page's "check expired tasks" behavior.
The WeChat process does not implicitly start an all-account scheduling loop, nor does it automatically approve expiry payments.
When periodic background checks are needed, configure the [scheduling entry](scheduled-tasks.md#deployment-entry-point) separately.
Current WeChat notifications reply on active query or expiry check and do not promise unattended on-time push.

Creating brand-new physical cards, card cancellation, contact editing, self-transaction marking,
manual takeover, and developer maintenance are still handled through the corresponding web page entries.
The WeChat channel does not add bank write permissions that the model did not originally have.

## Configuration and Status

The following runtime options can be set in `.env.local`:

```dotenv
WEIXIN_BANKING_URL=http://127.0.0.1:3000
WEIXIN_STATE_DIR=.local/weixinbot
```

The bank interface address is restricted to the local loopback address.
WeChat receives messages through outbound long polling and does not require opening inbound ports.
After the bank service changes ports, adjust `WEIXIN_BANKING_URL`.
The channel and the bank service run on the same computer.

```sh
pnpm weixin:status
pnpm weixin:login --force
pnpm weixin:logout
```

`status` only reports the local login cache and does not prove that the WeChat session is still valid.
When the cache expires, use `login --force` to scan the code again.
`logout` clears local credentials and bindings and does not replace account management in the WeChat client.
Before logging out or scanning the code again, first stop the message-receiving process with Ctrl+C.

Tokens and bindings are stored in `.local/weixinbot/state.json`.
`.local/`, QR codes, and test logs are all ignored by Git.
This directory relies on the file access permissions of the current operating system account.
Do not copy token files into source code, model context, or reports.

## Message and Permission Boundaries

- Only the scanned user in the login result is accepted; "automatically bind the first sender" is not used.
- Group chats, strangers, bot echoes, and incomplete messages do not enter the model.
- Currently text is supported; images, files, and voice are not handed to the model for recognition.
- A single process processes messages serially, and the same state directory uses an exclusive process lock.
- Message numbers are bound to bank request numbers, so duplicate deliveries do not generate a new round of business.
- Replies are first saved to the local reply queue, and on send failure the same `client_id` is resent.
- The most recent 2000 processed replies are retained locally. Bank requests themselves still use stable request numbers.
- Mobile numbers and card numbers in replies are always masked; masking is for display only and is not used to determine identity.
- This is a channel for one scanned user to access one shared demo account, not a multi-person banking identity system.

The channel does not load `pi-weixinbot`'s default encoding extension entry.
Therefore it does not add shell, file operations, or arbitrary-recipient sending tools to the bank model.
The channel imports only the upstream WeChat protocol module and always replies to the bound sender.
Upstream legacy Pi peer dependencies are marked optional, and the bank runtime still uses the project's Pi 1.2.

The repository maintains 2 patches for the upstream package:
preserve uint64 message number precision; the send interface checks WeChat business errors even when HTTP is 200.
The patches are pinned by the pnpm lockfile and `patches/pi-weixinbot@1.0.5.patch`.

## Testing

```sh
pnpm exec vitest run tests/unit/weixin-action-references.test.ts tests/unit/weixin-channel.test.ts tests/unit/weixin-presentation.test.ts tests/unit/weixin-lock-presentation.test.ts tests/integration/weixin-protocol.test.ts
pnpm exec tsx tests/e2e/weixin-live.e2e.ts
```

The first verifies binding, deduplication, explicit authorization, state persistence, upstream protocol, and lock reply wording.
The second invokes the real model and bank service and uses Chrome to check web page status.
This test creates a brand-new isolated database each time, and the WeChat side uses a local protocol server.
Therefore the second cannot replace real WeChat acceptance of "send a message from a phone and receive a reply."
Results are written to `logs/weixin-live-acceptance.json` and `logs/weixin-live-acceptance-<runId>.json`, and the exit code is non-0 on failure.

After setting `WEIXIN_LIVE_EXTENDED=1` and running the second command,
it also checks queries, wealth management, cards, subscriptions, budgets, scheduled distribution, and task control.
Archived searches and post-cancel conversation state are also within the scope of the extended tests.
The extended tests only set one reminder as expired in a newly created test database,
do not pass a test clock to the HTTP interface, and do not modify the WeChat demo database.

Real WeChat acceptance: after scanning the code to log in, test balance query, small transfer pending confirmation,
confirm execution, large-amount operation wrong-code rejection, correct verification, and cancellation.
Also check the web page operation status, account balance, and transactions.
