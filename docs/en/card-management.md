# Card Management

**English** | [简体中文](../cn/card-management.md)

The Cards page and the Agent divide responsibilities for managing simulated card records.
Adding a card does not apply to a bank for account opening or credit granting.
Deleting a card does not close a bank account, nor does it reverse transactions.
For amount units and settlement rules, see [Financial Values and Settlement](financial-values.md).

## Card Types and Sources of Funds

Deposit accounts and bank cards are independent records.
The savings account in the initial data has the suffix `3309` and a balance of 50000.00 yuan, with no separately issued card.
Both the Assets page and the Cards page display account details; the Cards page also indicates whether a bank card is linked.
`numberMasked` in account queries is an account number and does not imply the existence of a bank card with the same suffix.

Debit cards and virtual cards deduct cash from the settlement demand account when spending.
Credit cards use credit limits when spending and are not bound to a settlement account.

| Card Type | `type` | Source of Funds | Spending Limit |
| --- | --- | --- | --- |
| Debit card | `DEBIT` | Bound demand settlement account | The lesser of the account balance and the remaining monthly limit |
| Virtual card | `VIRTUAL` | Bound demand settlement account | The lesser of the account balance and the remaining monthly limit |
| Credit card | `CREDIT` | `creditLimit` credit limit | `availableLimit` |

Debit cards and virtual cards are each bound to 1 of the user's own demand accounts as the settlement account.
These two card types have no balance of their own: the account balance is the cash in the settlement demand account and is never a credit limit.
The available balance is the amount this card can currently spend, i.e. the lesser of the account cash and the remaining monthly limit.

The monthly limit (`monthlyLimit`) restricts the cumulative spending of this card type in the current month.
When the monthly limit is empty, the account balance and the applicable category limit are still checked.
The cumulative spending for the current month is calculated on a combined basis across cards before and after replacement.
A replacement card inherits the category spending limit of the original card, including the 0 yuan limit.
The cumulative spending for the current month for a category is also calculated on a combined basis across cards before and after replacement.
A repeated replacement returns the original replacement card and does not overwrite limits adjusted after the replacement.
For specific deduction and bookkeeping rules, see [Spending Settlement](#spending-settlement).

## Settlement Account Binding

A card uses `Card.linkedAccountId` to record the settlement account.
This field maps to the `linked_account_id` column and is a real foreign key pointing to `Account.id`.
This column is indexed; the foreign key is handled according to Prisma's default `SetNull`, and when the account is deleted this column is set to `NULL`, and the card is accordingly resolved as `MISSING`.

The server resolves the settlement account according to the following rules:

- When `linkedAccountId` is passed in, the account must exist, belong to the card's user, and be of type `CHECKING`.
- When `linkedAccountId` is not passed in, this account is used only if the user has exactly 1 demand account.
- When the user has 0 or more demand accounts, creation fails and returns `VALIDATION`.
- A replacement card inherits the settlement account from the explicitly specified predecessor card and re-validates it within the transaction.
- `consumeCard` returns `CONFLICT` when encountering `MISSING` or `UNTRUSTED`.

The server does not guess which account the card deducts from.
When the account does not exist, belongs to another user, or is not of type `CHECKING`, it is resolved as unavailable.
Note: Cards without a bound settlement account are completed using the backfill script; see [Data Upgrade and Rollback](#data-upgrade-and-rollback).

## Card View and Balance Display

`CardView.linkedAccountStatus` is the sole source of the linkage state.
This field takes one of 4 values, and every `CardView` must include this field.

| Value | Meaning | Balance Fields |
| --- | --- | --- |
| `LINKED` | The user's own demand account is recorded and the account is resolvable | Return the account balance and available balance |
| `MISSING` | No settlement account is recorded | Do not return |
| `UNTRUSTED` | The recorded account does not exist, belongs to another user, or is not a demand account | Do not return |
| `NOT_APPLICABLE` | Credit card, does not use a settlement account | Do not return |

Cards with `MISSING` and `UNTRUSTED` do not return any balance fields.
The page must not display these two states as `0.00`, nor must it fill in a default account.
Unknown balance and zero balance are two different facts.

When `LINKED`, the view returns the following fields:

- `linkedAccountName`: Settlement account name, such as "活期账户" (demand account).
- `linkedAccountNumber`: Masked account number, such as `****8821`.
- `accountAvailableBalance`: Account balance; the UI copy uses `business.cards.accountBalance`.
- `payableAmount`: Available balance; the UI copy uses `business.cards.usableBalance`.

When multiple cards are bound to the same account, they share these 1 portions of account cash.
Each card calculates its available balance according to its own remaining monthly limit.

## Card Status and Spending Entry Point

Simulated spending supports only debit cards and virtual cards.
Credit cards do not display a spending button and show the prompt "信用卡暂不支持模拟消费" (credit cards do not currently support simulated spending).
Only debit-type cards with normal status, a trustworthy and already-bound settlement account can open the spending form.
Directly mounting the dialog or forging a credit card spending request also cannot deduct funds.
When the server rejects a credit card spending, it returns `409 CONFLICT`.

`CardView.usable` equals `status === 'ACTIVE'`.
When `FROZEN`, `LOST`, or `PENDING`, this value is `false`.
At this time, the page's spending entry point is disabled and shows an unavailable prompt.
The balance fields still return real values, and cards with `LINKED` still display the account balance and available balance as usual.
The prompt copy takes `business.cards.cardFrozenNotice`, `business.cards.cardLostNotice`, or `business.cards.cardUnavailable` according to status.

## Spending Settlement

`banking-sdk/card.ts#consumeCard` completes eligibility re-verification, limit determination, deduction, and bookkeeping within a single transaction.
The settlement account and card status are re-validated within the transaction, without reusing read results from outside the transaction.

The transaction executes in the following order:

1. Read the committed spending record by `executionKey`; if found, replay the saved result as-is without deducting again.
2. Read the card and confirm it belongs to the user and has status `ACTIVE`; if the card does not exist return `NOT_FOUND`, and if the status is not `ACTIVE` return `CONFLICT`.
3. Re-validate the settlement account; both `MISSING` and `UNTRUSTED` return `CONFLICT`, and indicate the status in `detail.linkedAccountStatus`.
4. Read the cumulative spending for the current month for each card before and after replacement at the same server time.
   Check the monthly limit and the category limit for this category separately; if either upper limit is exceeded, return `LIMIT_EXCEEDED`.
5. Write the account balance using an atomic deduction with a balance lower bound; if no row is updated, return `INSUFFICIENT_FUNDS`.
6. Write the `channel='CARD'` transaction entry and 1 `CardConsumption` records, then write the result snapshot of this operation into the `resultJson` of that record.

The spending time is determined by the server's business clock; the caller does not provide a time parameter.
The current-month window is the business month in UTC+08:00; limit determination and bookkeeping use the same time.
Concurrent calls with the same `executionKey` produce only 1 deduction; the losing transaction rolls back, re-reads the committed record, and replays.

Rejection codes and trigger conditions are as follows:

| Error Code | Trigger Condition |
| --- | --- |
| `VALIDATION` | A time field was submitted, the amount is not greater than zero, the category is not supported, or the user id or card id is missing |
| `NOT_FOUND` | The card does not exist or does not belong to the user |
| `CONFLICT` | The card status is not `ACTIVE`, the settlement account is `MISSING` or `UNTRUSTED`, or the replay identity does not belong to this spending |
| `LIMIT_EXCEEDED` | This spending would cause the same card chain's current-month spending to exceed the monthly limit or the corresponding category limit |
| `INSUFFICIENT_FUNDS` | Insufficient cash in the settlement account |

The SDK uses the same set of spending rules for debit cards and virtual cards, and the Agent registers only the 1 spending tool `consume_virtual_card`.
There are 2 spending entry points:

- API `POST /api/cards/[id]/consume`: The first submission of spending parameters only creates a pending-verification operation and does not deduct funds. Re-submitting the original parameters along with `actionId`, `confirmed:true`, and `code` verifies and executes. Returns `CardConsumptionResponse`; on success `result` contains `ConsumeCardResult`.
- Agent tool `consume_virtual_card`: A RED operation; the parameter table has no date or time field.

The API checks whether the raw request body contains the `occurredAt` key; if present, it returns `VALIDATION` regardless of the value.
The tool uses `rejectClientSuppliedTime` to reject time fields such as `occurredAt` and `bookedAt` before calling the SDK.
Both rejections occur before any read or write, so no deduction, transaction entry, or spending record is produced.

## Asset Summary Basis

Total assets are the sum of account cash and position valuations; cards are not counted separately in the balance.
When multiple cards are bound to 1 account, that account's cash is counted only 1 time.
After replacement, the old card is in the terminal state `LOST`, and the credit limit is assumed by the replacement card.
The total available credit sums only credit cards that are not reported lost: `type === 'CREDIT'` and `status !== 'LOST'`.

## Masking and Account Isolation

Masking functions are centralized in [lib/mask.ts](../../lib/mask.ts).
This module provides `maskPhone`, `maskAccountNumber`, and `maskCardNumber`.
Account numbers and card numbers retain only the last 4 digits, with length unchanged.
Logs, API responses, and model tool results must not contain full account numbers or card numbers.
The card view reads only the current user's accounts.
For the selection rules for payees and cards, see [Number and Card Identity Resolution](identity-resolution.md).
When the settlement account does not belong to the current user, the view returns `UNTRUSTED` without stating the specific reason.

## Presentation Layer Rendering

The Cards page and conversational cards share the same set of display determinations.

- [card-account-display.ts](../../components/banking/card-account-display.ts) provides 4 state determination functions.
- [CardTile](../../components/banking/CardTile.tsx) and [CardsCard](../../components/chat/cards/CardsCard.tsx) render amounts according to the determination results.
- [Cards page](../../app/cards/CardManager.tsx) disables the spending button according to `usable`.
- [Spending dialog](../../app/cards/CardConsumeDialog.tsx) blocks submission when `usable` is `false`, `MISSING`, or `UNTRUSTED`.

An unlinked account displays `business.cards.linkedAccountMissing`.
An unavailable account displays `business.cards.linkedAccountUntrusted`.

## Responsibilities of the Page and the Agent

| Operation | Entry Point | Authorization |
| --- | --- | --- |
| Query cards | Cards page or AI assistant | Query own resources |
| Set category spending limit | AI assistant | Confirmation of the original operation |
| Freeze, unfreeze, report lost, replace card | AI assistant | Confirmation of the original operation and verification code |
| Apply for virtual card | AI assistant or Cards page | Confirmation of the original operation and verification code |
| Add, delete card records | Cards page | Page review of details and verification code |

The Agent does not register the ability to create or delete physical debit cards and credit cards.
The permission gateway and plan compiler also reject such calls.
Explicit add/delete requests only return instructions for operations on the Cards page.
The Agent registers virtual card applications and replacement of lost cards; both are RED operations.
The model cannot continue executing operations from old conversations.

## Page Flow

1. Select add card, or select the delete button of an existing card.
2. When adding, select the type and fill in the applicable limit.
3. Submit the operation preview.
4. Review the details, confirm the operation, and enter the demo verification code.
5. After the operation completes, the page refreshes the card list.

Supports debit card, credit card, and virtual card records.
The system generates both a fictitious full card number and a masked card number for display for each new card.
The full card number is stored in `Card.numberFull` and is used only for exact matching on the server.
The masked card number is derived from the same full card number, stored in `Card.numberMasked`, and used for display.
Only the masked card number appears externally; for the boundary, see [Storage and Masking Boundary of Full Numbers](identity-resolution.md#storage-and-masking-boundary-for-complete-numbers).
The page does not accept real card numbers, passwords, or security codes.
The limit input is a decimal string; the database uses integer cents.

Incomplete operations are saved in the database.
After the page refreshes, you can continue reviewing or cancel.
Closing the dialog only closes the interface; it does not cancel a saved operation.
To cancel, use the cancel button in the dialog.
These operations do not appear in the confirmation cards of AI conversations.

## Submission and Retry

Each operation uses a stable request identifier bound to the user and parameters.
Changed parameters cannot reuse the original request identifier.
A verification code challenge is bound to the original operation and does not authorize another card.

The actual change, verification code consumption, operation result, audit, and execution receipt are committed in the same transaction.
If the audit fails, the change rolls back.
When verifying an already-completed operation again, the original execution receipt is read without repeating additions or deletions.
If the process exits before commit, no committed card change is produced.
If the process exits after commit, the original result can be read.

## Deletion Restrictions

A credit card cannot be deleted when it has unrepaid credit or lacks credit information.
It cannot be deleted when related operations are still pending confirmation, executing, or have an unclear result.
It also cannot be deleted when a running model or task has not yet clearly referenced the object.
The deletion check is executed again within the actual change transaction.

Deletion preserves transaction entries, operation audits, and the original execution receipt.
The historical results of completed operations do not disappear because of card deletion.

## Data Upgrade and Rollback

The foreign key column keeps the `linked_account_id` column name; the upgrade does not rename this column.
The changes are the foreign key relationship and index; existing data remains readable.
The settlement account is allowed to be empty; unbound cards are resolved as `MISSING`.

### Upgrade Steps

1. Stop the application and the recovery process.
2. Stop the database connection and create a database snapshot according to [the backup steps in the development guide](development.md#database-backup-and-net-value-share-upgrade).
3. Synchronize the foreign key and index.

   ```sh
   pnpm db:push
   ```

4. Rehearse the backfill plan without writing data.

   ```sh
   pnpm exec tsx scripts/card-account-binding.ts --dry-run
   ```

5. Write the bindings.

   ```sh
   pnpm exec tsx scripts/card-account-binding.ts
   ```

6. Review the output report and change manifest.

   The manifest is saved in `logs/card-account-binding/<时间戳>-applied.json`.

Warning: Skipping the backup will lose committed card records.

### Rollback Steps

Only the values written by the backfill script need to be rolled back.
The foreign key and index are compatible changes and can be retained.

1. Stop the application and the database connection.
2. Execute the rollback command.

   ```sh
   pnpm exec tsx scripts/card-account-binding.ts --rollback=logs/card-account-binding/<时间戳>-applied.json
   ```

3. If earlier data needs to be restored, overwrite the database with the snapshot in `logs/db-backups/`.

Rollback only restores rows that still hold values written by the script; manually modified rows remain unchanged.

### Backfill Rules

The script processes only debit cards and virtual cards whose `linkedAccountId` is empty.
Credit cards use credit limits, and the script skips them.
When the user has exactly 1 demand account, the script binds that account.
When the user has 0 or more demand accounts, the script skips and reports `no-checking-account` or `ambiguous-checking-accounts`.
Writing uses compare-and-swap, updating only rows that are still empty.
Idempotent on repeat execution: an already-bound card reports `already-bound`.
Planned accounts are re-read by identifier, and written after verifying ownership and type.
Script output contains only accounts that have been masked in the database.

## Code entry points

- [Card page](../../app/cards/page.tsx) reads the card list.
- [Page interactions](../../app/cards/CardManager.tsx) manage preview, validation and refresh.
- [Spending dialog](../../app/cards/CardConsumeDialog.tsx) submits a locally simulated spend.
- [Card SDK](../../banking-sdk/card.ts) resolves the settlement account, deducts cash and generates the card view.
- [Spending API](../../app/api/cards/[id]/consume/route.ts) rejects the caller's time and calls `consumeCard`.
- [Card utilities](../../agent/tools/card.ts) define selectors and the time guard for `consume_virtual_card`.
- [Card DTOs](../../banking-sdk/types.ts) define `CardView` and `linkedAccountStatus`.
- [Database schema](../../prisma/schema.prisma) defines the `linked_account_id` foreign key and indexes.
- [Demo seed](../../prisma/seed.ts) binds debit cards and virtual cards to `acct_checking`.
- [Backfill binding script](../../scripts/card-account-binding.ts) backfills unbound cards.
- [Masking module](../../lib/mask.ts) provides masking for phone numbers, account numbers and card numbers.
- [Manual card changes](../../security/manual-card-management.ts) check ownership, challenge and submission result.
- [Card HTTP boundary](../../app/api/cards/CONTEXT.md) passes the whole `CardView` object through.
- [API tests](../../tests/app/manual-card-management.test.ts) check authorization, retry, isolation and rollback.

The verification code still uses the demo adapter and does not send SMS.
The fixed demo identity does not provide production account-opening or card-cancellation authentication.
For test methods and evidence scope, see [Test notes](test-cases.md).
For permissions, verification codes and auditing, see [Security design](security.md).
