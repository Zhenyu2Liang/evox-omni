# Overview of Implemented Features in Wanxiang Guifang EvoX Omni

**English** | [简体中文](../cn/implemented-features.md)

The project supports simulated banking business via web pages and WeChat text conversations.
After the user describes a need, the banking agent queries objects, plans steps, and invokes banking tools.
For business that requires confirmation or verification, the server pauses execution and waits for the user to act.

Accounts, transactions, and identity verification are all for demonstration and are not connected to real banking or payment services.
This description is compiled from the current code and does not mean that all acceptance checks were re-executed this time.

## 1. Access Points

| Entry | Function |
| --- | --- |
| Web AI assistant `/agent` | Natural-language conversation, business result cards, operation confirmation, verification codes, and multi-step task control |
| WeChat channel | Text private chat, business results, explicit confirmation and verification, task control, and due checks |
| Business pages | View assets, bills, cards, wealth management, subscriptions, contacts, and scheduled tasks |
| Operation records and security center | View business processing status, verification records, and security lock status |
| Developer mode | View runtime, audit, and execution evidence; use manual review and demo maintenance entries |

The web uses a fixed demo user and requires no login.
Different browsers and bound WeChat users share the same demo account and conversations.
The interface defaults to Chinese and supports switching to English.

## 2. Natural-Language Conversation

The banking agent supports conversation, business consultation, data queries, and business handling.
Asking how to handle a certain business does not equal authorization to execute that business.
When the amount, payee, or target card is missing, the model may continue to ask.

Conversation capabilities include:

- Retaining multi-turn conversation context.
- After querying contacts, accounts, cards, and products, initiating business with the exact objects.
- Saving complete conversation archives and viewing historical messages page by page.
- Searching historical original utterances and retaining the original amounts, negative signs, and corrections.
- Using the official Pi interface to compress model context while keeping the original archive.
- Displaying query results, operation details, execution receipts, and task node status.

Model body text is used for explanation; business cards are used to display server-side facts.
"Confirm" in ordinary chat cannot replace operation confirmation or a verification code.
Online models may still misunderstand or fail to initiate business, and users need to check the actual operation cards.

## 3. Accounts and Transfers

### 3.1 Account Queries

- Query current account and savings account balances.
- Query asset overview, posted consumption for the current month, and available credit for credit cards.
- Find existing contacts by name, mobile number, or note.
- Add or delete contacts on the contacts page.

The asset overview aggregates account balances and wealth management holdings valuations.
Credit card available credit is displayed separately and is not counted again as deposit balance in assets.

### 3.2 Smart Transfers

- Resolve payees by existing contact name, mobile number, or note.
- Specify transfer amount, note, and a supported payment account.
- Display payee, amount, payment account, and risk level before execution.
- After confirmation, deduct funds and write transaction records and an execution receipt.
- Cancel an operation that has not yet been executed.

Transfers use the owning user's current account.
When a single transaction amount or the daily cumulative amount exceeds 1000.00 yuan, strong verification is required.
Cumulative risk is rechecked at confirmation, and already authorized in-flight transfers also count toward the cumulative total.
Repeated confirmation or duplicate message delivery must not cause duplicate deductions.

Example: `从活期账户转账200.37元给张伟，备注打车。`

For specific permission rules, see [Security Design](security.md#permission-levels).

## 4. Bill Analysis and Abnormal Transactions

- Query transaction records by time, category, and count.
- Calculate monthly consumption categories, total consumption, and month-over-month changes.
- View monthly and annual bill reports at `/bills/reports`, and generate model analysis on demand.
- Export CSV, HTML with charts and analysis, or PDF.
- View consumption trends, merchant statistics, and single-transaction information.
- Identify suspicious transactions according to configured rules and display the reasons.
- Mark suspicious transactions as self-authorized transactions on the web.

Suspicious consumption remains in the total posted consumption and is displayed separately.
An abnormal mark does not equal confirmation of fraud and does not automatically freeze the card.
Self-authorized transaction confirmation saves a processing record and does not delete the original transaction or abnormal mark.

Example: `分析2026年9月的消费分类，并检查异常交易。`

For report usage, statistical definitions, and export formats, see [Bill Reports](bill-reports.md).

## 5. Wealth Management Products and Holdings

### 5.1 Product Queries and Comparison

- View product risk levels, expected annualized returns, terms, and minimum purchase amounts.
- Compare wealth management products.
- View remaining holding cost, market value derived from shares and the latest net value, and holding returns.
- Answer questions about product differences and selection based on query results.

### 5.2 Purchases and Additional Purchases

Purchases deduct from the current account and save holdings, fund transactions, and receipts.
When purchasing the same already-held product again, the amount is merged into the existing holding.
The page displays the most recent purchase time and purchase count.

Example: `从活期账户申购1000元稳健理财A。`

### 5.3 Full, Share-Based, and Amount-Based Redemptions

Redemption must declare one of the following 3 bases:

- `SHARES`: redeem by shares.
- `AMOUNT`: redeem by amount.
- `ALL`: redeem all shares and close the holding.

A missing basis, unknown basis, or mixed bases are all clarification cases, and no default value is applied.
The retired `redeemAmount` is likewise a clarification.
For amount-based redemption, the server converts the amount to shares using the latest net value and rounds down to 6 decimal places.
The settlement amount undergoes only 1 rounds of `HALF_UP` rounding to cents.
Full redemption settles the entire holding.
Share-based or amount-based redemption keeps the holding, reduces the remaining cost proportionally, and realized returns may be negative.

Redemption proceeds are transferred to the current account, and fund transactions and receipts are saved at the same time.
When the same execution identity is submitted repeatedly, the original result is returned and no duplicate credit is made.

Example: `从稳健理财A持仓中按金额赎回 1000 元，保留剩余持仓。`
Example: `从稳健理财A持仓中赎回 500 份。`

Both purchases and redemptions require confirmation and strong verification.
Expected returns and market value are demo valuations.
The system does not provide a complete risk tolerance assessment questionnaire.
For bases and settlement rules, see [Wealth Management Products](investments.md); for amount rules, see [Financial Values and Settlement](financial-values.md).

## 6. Card Management and Virtual Cards

### 6.1 Card Queries and Control

- Query the status and limits of debit cards, credit cards, and virtual cards.
- Set category spending limits without changing bank credit lines.
- Temporarily freeze cards and unfreeze them when needed.
- Formally report cards lost and replace lost cards with new ones.
- Add or delete simulated card records on the card page.

Temporary freezes can be lifted.
Formal loss reports are irreversible, and the original card cannot be restored even if found.
Replacement generates a new card number of the same type, and the original card remains in lost status.
Credit card replacement inherits the original credit line and current available credit; the original card is in the final lost state and is not counted in the available credit summary.

Creating new physical debit cards and credit cards and deleting card records are handled on the web.
The banking agent can handle virtual card applications and replacement of lost cards.
Adding a card on the page does not represent real account opening or credit approval.

### 6.2 Virtual Cards Bound to Current Accounts

Both debit cards and virtual cards are bound to the user's own settlement account, and the card itself does not hold a balance.
Virtual card spending deducts funds from the settlement account; when multiple virtual cards are bound to the same account, they share that account's funds.
When the bound account is missing or fails validation, the card omits the balance field and is not displayed as 0.

- At application, validate account ownership and current account type.
- Display the account available balance, monthly spending limit, and current payable amount.
- During simulated spending, deduct from the bound account and save transactions and card spending records.
- Cards in frozen or lost status cannot spend.
- After replacement, the settlement account is retained and the remaining monthly spending limit continues.

The current payable amount takes the smaller of the account available balance and the remaining monthly limit.
When no monthly limit is set, the account available balance is the funding cap.
When the monthly limit is set to 0, no spending is possible.

Example: `申请一张月消费限额100元、绑定活期账户的虚拟卡。`

Virtual card spending is a local simulation and is not connected to real merchant payments.
For card page flows and deletion restrictions, see [Card Management](card-management.md).

## 7. Subscription and Auto-Debit Management

- Query subscriptions and auto-debit records in the demo data.
- View charge amounts, cycles, next charge times, and subscription status.
- Turn renewal reminders on or off.
- Cancel subscriptions.
- Answer subscription trade-off questions based on costs and user needs.

Querying subscriptions requires confirmation.
Canceling subscriptions or changing reminders also requires confirmation.
Asking "which subscription can be canceled" only produces analysis and does not directly cancel the service.
These operations modify local simulated records and are not connected to real subscription merchants.

Example: `取消Netflix订阅，并开启Spotify的续费提醒。`

## 8. Budgets and Scheduled Tasks

### 8.1 Budget Records

The system can register budget names, amounts, and purposes.
Budgets are only for bookkeeping and do not freeze or transfer account funds.

Example: `登记500.50元生日礼物预算，只记账不转账。`

### 8.2 Scheduled Reminders and Payment Intentions

- Save reminders, transfers, or payment intentions by specified date and time.
- Display scheduled task status and reminder notifications.
- Check due tasks via the page, WeChat commands, or the command line.
- After a reminder is due, save a notification.
- After a payment is due, create the original payment workflow, then check confirmation and verification requirements.
- Repeated checks reuse the original task to avoid duplicate notifications or duplicate creation of payment entries.

Starting the web service does not automatically start a persistent scheduler.
When periodic background checks are needed, separately configure a scheduling service to invoke the check command.
WeChat currently returns notifications via active queries or due checks and does not provide automatic push at the due time.

Example: `在2099年12月20日上午9点提醒我检查账单，只提醒，不付款。`

For dates and dispatch rules, see [Scheduled Tasks and Reminders](scheduled-tasks.md).

## 9. Cross-Scenario Workflows

Complex requests can be orchestrated as directed acyclic graph (DAG) workflows.
Each node retains dependencies, execution status, and the original operation identity.

- Execute businesses such as queries, limit adjustments, budgets, and scheduled tasks step by step.
- Use conditions explicitly required by the user to control subsequent steps.
- Pause, resume, cancel, and retry supported tasks.
- Restore task status and pending confirmation entries after refresh.
- Roll back revocable budget or scheduled records.
- Submit manual takeover in developer mode and register review conclusions.

Submitting a plan does not equal authorization for the bank write operations within the plan.
Each node still independently passes permission checks, and confirmation and verification cannot be reused across operations.
Cancellation prevents subsequent execution, and posted transactions are retained.
Workflows do not provide fund rollback for the entire plan.

Example: `先分析2026年9月消费，再把借记卡购物分类限额设为900.50元，最后登记219.87元预算。每一步成功后再做下一步。`

Birthday scenarios can combine budgets, reminders, and future payment intentions.
The system does not actually freeze the birthday budget, nor does it order flowers or cakes from merchants.
For manual handling boundaries, see [Manual Review](manual-review.md).

## 10. WeChat Channel

The WeChat channel uses the `pi-weixinbot` protocol module to connect to existing banking services.
After QR code login, it receives only complete text private chats from the bound user.
Natural-language business reuses the web's tools, permissions, audit, and execution receipts.

| Interaction | WeChat Command |
| --- | --- |
| View help and pending operations | `/帮助`, `/待办` |
| Confirm, verify, cancel a specified operation | `/确认 操作编号`, `/验证 操作编号 六位验证码`, `/取消 操作编号` |
| View or control tasks | `/任务`, `/暂停 任务编号`, `/继续 任务编号`, `/取消任务 任务编号` |
| Retry or roll back records | `/重试 任务编号`, `/回退记录 任务编号` |
| Review and restore the original operation | `/恢复操作 操作编号` |
| View scheduled tasks and check due items | `/定时任务`, `/检查到期` |

Server-side operation details are displayed before confirmation, and verification code commands are not passed to the model.
Group chats, strangers, and bot echoes do not enter the banking agent.
Currently, WeChat images, files, or voice are not recognized, and multi-user banking identity binding is not provided.
For configuration and operation instructions, see [WeChat Channel](weixin.md).

## 11. Security, Records, and Recovery

The server provides the following mechanisms:

- Control automatic execution, confirmation, and strong verification by green, yellow, and red permissions.
- Check resource ownership, parameter types, and amount ranges.
- Restrict the model to registered banking tools and do not provide arbitrary code execution capability.
- Bind verification code challenges to the original operation and limit validity periods and failure counts.
- When verification code failures reach the upper limit, the operation is written as `locked` by `pending` or `awaiting_mfa` compare-and-swap.
- `locked` will no longer prompt, verify, cancel, or restore thereafter.
- The circuit-breaker lock is determined by account owner (`user:<userId>`), and other operations on the same account also report locked.
- The top-level failure code is always `CIRCUIT_OPEN`, and the reason is distinguished by `failure`.
- This operation exhausted attempts: `failure.code` is `MFA_LOCKED`, and `reason` is `mfa_attempts_exhausted`.
- Account circuit-broken elsewhere: `failure.code` is `CIRCUIT_OPEN`, and `reason` is `circuit_open`.
- Internal markers do not enter user-visible text.
- Save circuit-breaker state to the database and record failure, lock, and release events.
- Place business writes, required audit, and execution receipts in the same transaction.
- Deduplicate using execution identity, and repeated requests read the original result.
- Save model requests, event logs, tool calls, and recovery checkpoints.
- When an operation has an unclear result, transfer it to manual review and retain execution evidence.

Ordinary users can view business processing status in "Operation Records."
Developers can view execution evidence in "Operation Audit" and "Runtime Records."
The recovery service must be started separately and does not run resident by default with the Web service.

Current verification uses the demo verification code `123456`, and the system does not send SMS.
The project does not provide production login, real face authentication, or independent employee role management.
For design notes, see [Security Design](security.md) and [Persistence and Recovery](agent-durability.md).

## 12. Competition Scenario Coverage and Boundaries

| Competition Scenario | Provided Features | Current Boundaries |
| --- | --- | --- |
| Smart transfers | Contact resolution, confirmation, cumulative risk control, strong verification, due payment workflow | No real fund transfers; no AA collection product flow provided |
| Bill analysis | Transactions, monthly and annual reports, category statistics, model interpretation, PDF/HTML/CSV export, anomaly identification, self-authorized transaction marking | Only simulated RMB posted transactions; PDF requires a local browser |
| Wealth management operations | Product comparison, holdings, purchase merging, full, share-based, and amount-based redemption | No complete risk tolerance assessment questionnaire or real sales system |
| Card management | Queries, category limits, freeze and unfreeze, loss reporting and replacement, virtual cards | Does not approve credit lines; page add/delete only manages simulated records |
| Subscription auto-debit management | Queries, renewal reminder settings, subscription cancellation | Not connected to external merchant cancellation interfaces or automatic due-time push |
| Cross-scenario linkage | Workflows, budgets, reminders, and future payment intentions | Does not freeze budgets and does not actually purchase goods |
| Multi-channel access | Web and WeChat text conversations | Single demo account; does not support group chats, voice, or multi-user authentication |

Online model mode calls real model services, while banking business still executes in the local simulated environment.
Simulated model mode uses scripted responses and is suitable for offline demos and deterministic tests.
The reliability of multi-process, multi-instance, and real banking environments cannot be proven by local demos.

## 13. Basis for Feature Verification

This description is based on the following current source code and topic documents:

| Scope | Code or Document |
| --- | --- |
| Banking tools and default permissions | [Tool Catalog](../../lib/contracts/tool-catalog.ts) |
| Web business entries | [Application Pages](../../app) |
| Wealth management purchases, redemptions, and execution replay | [Wealth Management Business](../../banking-sdk/investment.ts) |
| Card control, virtual card spending, and replacement | [Card Business](../../banking-sdk/card.ts) |
| Fund and asset display | [Financial Values and Settlement](financial-values.md) |
| WeChat commands and result display | [WeChat Channel Code](../../channels/weixin) |
| Task orchestration and execution | [Workflow Executor](../../planner) |
| Verification methods and coverage | [Test Guide](test-cases.md) |

The current tool catalog provides 28 banking business and workflow tools.
The feature list represents capabilities already provided in code and does not guarantee that the model can correctly understand any expression every time.
During acceptance, actual operation records, balances, holdings, and transactions need to be checked.
Real WeChat sending and receiving requires a mobile phone, and protocol simulation tests cannot replace phone acceptance.
