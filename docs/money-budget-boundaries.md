# Financial and budget boundaries

## Current financial contract

Financial inputs and outputs use decimal strings. Booked CNY values have exact cent precision and signed INT64 persistence bounds; domain arithmetic uses bigint. Rates and unrounded valuations use Decimal arithmetic and SQLite TEXT persistence. See [financial value contracts](financial-values.md) for units, precision and settlement policy.

Only the current schema and API are supported. There are no numeric financial adapters, Float migrations, old request fingerprints, implicit missing-money defaults or receipt-less ledger reconstruction. `pnpm db:push` synchronizes the current schema; `pnpm db:reset` recreates the simulated dataset.

Public product rates use `annualYieldRate` as a ratio. Holding principal is `principalAmountMinor`; `estimatedMarketValue` remains unrounded. Subscription and redemption results preserve their original execution outcomes. Same-identity retries return those outcomes and never invent a current balance for an earlier execution.

## Authorization and booked totals

Committed transfer postings and authorized in-flight actions contribute to cumulative risk in cents. Exactly CNY 1000 remains YELLOW; CNY 1000.01 requires MFA. An unverifiable in-flight amount fails closed instead of reducing the cumulative total.

Bill `total` and `bookedTotal` include all posted consumption. `flaggedTotal` identifies flagged consumption separately. Investment cash flows remain outside consumption. Stable category totals include explicit zero values; ratios use integer arithmetic. Account, bill and asset summaries share one database snapshot. Asset totals preserve estimated valuation precision and do not represent withdrawable cash.

## Write fences and command outcomes

The server supplies write fences through the trusted invocation context. SDK transactions check current execution ownership and circuit-breaker policy before mutation. Input objects and JSON cannot supply a policy check. Mutation, mandatory audit, command receipt and linked invocation completion commit together.

Budget reservations use a unique `(userId, idempotencyKey)` identity. Same-user replay verifies the original name, amount, purpose and due date. Different users have independent local keys. A budget envelope does not reduce withdrawable cash.

Current valid receipts restore committed facts after interruption. Missing or corrupt execution evidence requires reconciliation. No uncertain operation is blindly retried. Finite business clocks use UTC+08:00 independently of real security and lease expiry.

## Verification scope

Regression tests cover exact decimal values, current command identity, receipt corruption, approval and settlement agreement, budget ownership, concurrent deduplication and write-time fencing. Offline suites share one test database and run sequentially. Browser acceptance uses an isolated simulated database; run it serially with the full deployment suite.
