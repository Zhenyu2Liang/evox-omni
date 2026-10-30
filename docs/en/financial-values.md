# Financial Values and Settlement

**English** | [简体中文](../cn/financial-values.md)

Entry amounts use integer cents. Net asset values, shares, and unrounded market values use Decimal.
The two types of values are distinguished by unit and cannot be uniformly changed to BigInt.

## Types and Units

| Value | Database Storage | Program Type | Unit |
| --- | --- | --- | --- |
| Balance, transactions, credit limits, subscriptions, budgets, minimum purchase amount | SQLite INTEGER, Prisma BigInt | bigint | RMB cents |
| Remaining holding cost `principalAmountMinor` | INTEGER | bigint | RMB cents |
| Annualized return rate `annualYieldRate` | canonical decimal TEXT | Decimal, string | dimensionless ratio |
| Market value snapshot `estimatedMarketValue` | nullable decimal TEXT | Decimal, string | unrounded RMB yuan, snapshotted at write time |
| Net asset value `latestNetValuePerUnit` | canonical decimal TEXT, on the product row | Decimal, string | RMB yuan per share, at most 4 decimal places |
| Shares `shares` | canonical decimal TEXT, on the holding row | Decimal, string | shares, at most 6 decimal places |

Financial values in public interfaces use decimal strings.
For example, 200 yuan is written as `"200.00"`, and the number `200` must not be passed.
Models, pages, and workflow conditions all follow this convention.
Workflow count values still use the separate number type.

`annualYieldRate` has only a ratio meaning.
For example, `"0.032575"` is displayed on the page as `3.2575%`.
Percentage conversion only happens at display time.

The public holding field `amount` represents the remaining holding cost.
`marketValue` is the unrounded market value derived from `份额 × 最新净值`.
When there are no available shares or the product has not published a net asset value, the market value falls back to the remaining cost.
In this case, `profit`, `profitRate`, and cumulative return are not provided; see [Wealth Management Net Asset Value and Shares](investments.md) for the convention.

## Decimal Operations

The [Decimal utility](../../lib/decimal.ts) uses an independent configuration.
Intermediate operation precision is 120 significant digits.
Domain values have at most 40 integer digits and 18 decimal digits.
Both inputs and computation results are checked against these bounds.

- Financial JSON number inputs are rejected.
- Scientific notation exponents are checked before creating a Decimal.
- Addition, subtraction, and multiplication preserve exact values within domain bounds.
- Infinite decimals or division exceeding the decimal place limit is rejected.
- Missing amounts do not automatically become zero.

SQLite's DECIMAL declaration cannot guarantee decimal precision.
SQLite may store that field as a binary floating-point number.
Therefore, exact decimals are stored as canonical TEXT.
The repository layer and banking tools check the text format and precision.
These TEXT fields do not use SQLite's numeric operations.

If a PostgreSQL adapter is added, NUMERIC can be used.
The adapter needs to specify precision, decimal places, and domain validation.
Chart coordinates may be converted to number; financial calculations must not be converted.

## Redemption Settlement

Entry amounts keep at most 2 decimal places.
Ordinary amount inputs with values less than 1 cents are rejected.

Simulated redemptions are rounded to RMB cents using HALF_UP.
HALF_UP means half a cent or more is rounded away from zero.
The valuation must be non-negative, and settlement is rounded only 1 time.
The final amount must also satisfy the storage range of signed INT64.
This rule is the settlement convention for the current simulated products.

The permission gateway and banking tools use the same conversion rule.
The authorization record is bound to the rounded amount.
Before submitting a transaction, the banking tool re-reads the holding and net asset value within the write transaction.
When the settlement amount changes, the banking tool rejects the entry.

A redemption must explicitly specify one of `SHARES`, `AMOUNT`, or `ALL`.
There is no default convention; missing, unknown, or mixed conventions are always rejected.
`SHARES` takes the given shares, and `AMOUNT` takes `FLOOR(金额 ÷ 净值, 6 位小数)`.
Requests are rejected when the converted shares are zero, the requested shares exceed the held shares, or the requested amount exceeds the holding market value.

The credited amount is the unrounded market value of `份额 × 成交净值`.
That market value is rounded HALF_UP to RMB cents only 1 time.
The cost consumed by the redemption is deducted proportionally by shares: `HALF_UP(剩余成本 × 赎回份额 ÷ 总份额)`.
The consumed cost is rounded to cents only 1 time, and the remaining cost equals the original remaining cost minus the consumed cost.
Realized return is `到账金额 − 消耗成本` and may be negative.
The sum of consumed cost and remaining cost always equals the original cost, and the ratio is computed in integer cents.
`redeemAmount` is not an available parameter; redemption requests carrying this field are rejected with `VALIDATION` before the holding is read.
Redemption goes through only the two quantities of shares and net asset value; there is no path that converts by principal ratio.

After a successful redemption, the original result stores the following fields at the same time:

- `redemptionValuation`: the unrounded market value of the redeemed shares.
- `settlementRounding`: the rounding rule, fixed as `HALF_UP`.
- The final settlement amount and the original execution balance.
- The execution identity and funding account.

When the same execution identity requests again, the original result is returned.
The original result of a partial redemption is stored in the holding's redemption record and replayed by the same identity.
Later valuation changes do not produce a second entry.
When there is a total loss, a zero settlement amount is valid.
Negative valuations and format errors fail before writing.

## Subscription and Original Result Replay

A subscription stores the complete `subscribeResult` within the same transaction.
Before replay, the system verifies the holding and the original result.
The return value preserves the original execution balance and funding account.
When the original result is missing or contradictory, the system stops and reports a conflict.

A further subscription to the same product is merged into the existing holding, not created as a new holding.
On merge, the remaining cost increases by this amount, and shares increase by `FLOOR(金额 ÷ 净值, 6 位小数)`.
Each subscription appends a purchase record containing the amount, shares obtained, execution net asset value, and post-operation balance.
The holding view returns the most recent subscription time and purchase count.
The original result of an additional subscription is stored in the corresponding purchase record and replayed by the same execution identity.

Committed results are read before current account and product conditions.
The current account type and product minimum purchase amount only constrain new operations.
Later changes to these conditions do not rewrite the original successful result.

Redemption replay also verifies the valuation, amount, and rounding rule.
The passed authorization amount must match the original settlement amount.
When the execution receipt or ledger evidence is incomplete, the case is transferred to manual verification.
See [Persistence and Recovery](agent-durability.md) for the verification mechanism.

## Bills and Asset Summary

`total` and `bookedTotal` include all entered consumption.
`flaggedTotal` lists suspicious consumption separately and does not deduct it from the total.
Investment cash flows are not counted as consumption.
Consumption categories preserve explicit zero values, and ratios use integer arithmetic.

Accounts, bills, and asset summaries use the same database snapshot.
Total assets include cash and the unrounded holding market value derived from `份额 × 最新净值`.
Therefore, total assets represent an estimate and cannot be treated as a withdrawable balance.

## Budget Limits

`reserve_budget` creates a budget limit.
A budget limit does not freeze funds or reduce the withdrawable balance.

Budgets use the `(userId, idempotencyKey)` unique key.
When the same user replays, the system verifies the original budget parameters:

- Name `name`.
- Amount `amount`.
- Purpose `purpose`.
- Due date `dueDate`.

The same local key for different users does not affect each other.
The execution receipt, audit, and budget change are committed in the same transaction.

## Database and Product Boundaries

The project supports only the current schema and financial interfaces.
See the [Development Guide](development.md) for database sync and reset steps.

Net asset values are given by simulated data; the system is not connected to a market data source and does not grow automatically over time.
Both subscriptions and redemptions are priced only at the published net asset value; products without a net asset value cannot be traded.
The current system does not calculate interest accrual.
When connecting to real market data, the source, publication frequency, and pricing time of the net asset value need to be defined.
See [Wealth Management Net Asset Value and Shares](investments.md) for the conventions on net asset value and shares.

## Verification Entry Points

| Code or test | What it verifies |
| --- | --- |
| [Amount utility](../../lib/money.ts) | Integer cents, INT64 bounds, and string interface |
| [Decimal utility](../../lib/decimal.ts) | Precision, exponents, decimal places, and division |
| [Financial value tests](../../tests/unit/financial-values.test.ts) | Interest rates, 18 decimal places, and half-cent settlement |
| [Original transaction result tests](../../tests/integration/write-idempotency.test.ts) | Subscription, redemption, and committed result replay |
| [Test guide](test-cases.md) | Receipt corruption, authorization amount, and concurrency tests |
