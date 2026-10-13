# Banking SDK

The SDK validates banking invariants and executes through repositories or `runInTransaction`. Permission tiers, human confirmation, MFA and circuit-breaker decisions belong to the security layer. It never executes model-generated code, SQL or shell commands.

## Public contract

Import capabilities from `banking-sdk/index.ts`; DTOs live in `types.ts`. Financial inputs and outputs are decimal strings. Repository persistence uses bigint CNY cents for booked money and canonical decimal TEXT for rates and estimates. `MoneyInput` accepts strings only. `normalizeMoney` validates booked precision; missing values are not zero.

The current product rate is `annualYieldRate`, a dimensionless ratio. Holding principal is `principalAmountMinor`; estimated CNY market value is `estimatedMarketValue`. Public holding `amount` is booked principal, while `marketValue` and `profit` preserve estimate precision. Percentages are display conversions only.

Decimal values allow 40 integer and 18 fractional digits. The SDK uses exact arithmetic, rejects invalid values and rounds only at a documented settlement boundary. The current redemption policy is HALF_UP to CNY cents; authorization and execution use the same conversion. Final balances and ledger entries remain signed INT64 cents.

## Transactions and execution context

`runInTransaction` composes with an existing transaction through the unit-of-work context. The trusted `BankingExecutionContext` supplies the execution fence and audit callbacks. These checks run inside the write transaction. There is no Symbol property or second fence carrier on tool inputs.

Transfers atomically debit an owned checking account, create its ledger entry and persist the original receipt. Replay verifies the current request digest, receipt and ledger before consulting mutable contacts. Missing evidence is a conflict, never reconstructed success. Concurrent same-key unique conflicts replay only verified committed evidence.

Investment purchase and redemption atomically change account balance, holding and ledger. Purchase stores its original SDK outcome; redemption stores its exact valuation, rounding policy, settled amount and original balance. Same-identity retries return those outcomes. A distinct redemption identity cannot redeem a closed holding again.

Budget and scheduled-intent creates use owner-scoped replay checks. Virtual cards use deterministic execution identities and verify monthly limits. Card transitions and subscriptions validate ownership and state. A budget is an accounting envelope rather than a funds hold.

## Errors and reads

Throw `AppError` with a domain code; agent runners convert business failures into typed tool outcomes. Never fabricate a success or current balance for an earlier write. Read models are DTO projections, preserve valuation precision and share a snapshot when combining cash with holdings.

Business dates use the explicit UTC+08:00 demo clock; security and leases use real time. Financial number conversion is allowed only for chart geometry and cannot feed authorization or execution.

## Storage lifecycle

Only the current schema and contracts are supported. `pnpm db:push` synchronizes the schema; `pnpm db:reset` recreates simulated data. Do not add old-schema migrations, numeric money adapters, old fingerprint acceptance or pre-receipt replay paths. Current receipts, audit and restart recovery are runtime guarantees rather than compatibility features.
