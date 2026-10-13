# Financial value contracts

Financial safety follows units and settlement semantics. It does not require every financial field to use the same numeric representation.

| Domain value | SQLite persistence | Application representation | Unit |
| --- | --- | --- | --- |
| Account balance, booked transaction, card limit, subscription, budget, minimum purchase | INTEGER / Prisma BigInt | bigint | CNY cents |
| Holding principal | `principal_amount_minor` INTEGER | bigint | CNY cents |
| Product annual yield | `annual_yield_rate` TEXT | Decimal / canonical string | Dimensionless ratio |
| Holding estimate | `estimated_market_value` TEXT, nullable | Decimal / canonical string | Unrounded CNY |

The sole product rate field is `annualYieldRate`, a dimensionless ratio in storage, repository inputs and public DTOs. `"0.032575"` is displayed as 3.2575%; percentages are presentation only. Public `amount` on a holding is the booked principal; `marketValue` and `profit` preserve estimate precision. Dashboard total assets combines exact cash with unrounded holdings estimates; it is an estimate, not a withdrawable cash balance.

Each holding DTO includes its complete product. Missing product metadata is an integrity error; presentation never synthesizes zero rates, terms or minimum amounts.

## Decimal arithmetic and validation

`lib/decimal.ts` uses an isolated decimal.js configuration, with 120 significant digits for intermediate calculations. Supported domain values have at most 40 integer digits and 18 fractional digits. Financial inputs are strings only; numeric JSON values are rejected. Scientific exponents are bounded before Decimal construction to prevent extreme inputs from silently underflowing to zero. Inputs and results are validated against the same bounds. Addition, subtraction and multiplication preserve values exactly within the domain; nonterminating or over-scale division is rejected instead of silently rounded. `normalizeMoney` explicitly normalizes booked amounts; missing values are not silently interpreted as zero. Workflow scalar counts retain a distinct number contract.

SQLite's DECIMAL declaration has NUMERIC affinity and may store binary floating point; it does not enforce a decimal precision or scale. Therefore precise decimals are persisted as canonical TEXT and validated at repository and SDK boundaries. No SQLite SUM, CAST or arithmetic is applied to these text fields. A future PostgreSQL adapter can use NUMERIC with explicit precision and scale behind the same domain contract.

## Settlement and retries

Booked money still rejects fractional cents. The demo redemption settlement policy explicitly rounds a nonnegative valuation HALF_UP once to CNY cents, then enforces signed INT64 storage bounds. This is a demo product rule, not a universal rule for financial products.

The gateway and SDK use the same settlement conversion. Authorization binds the rounded amount; the SDK re-reads the estimate inside the write transaction and rejects a changed settlement amount before any credit. A completed redemption stores its exact quote (`redemptionValuation`), rounding policy (`settlementRounding`), final amount, original balance and execution identity together. Same-identity retries return that original result even if the estimate subsequently changes. Zero settlement is valid for a total loss; negative or malformed valuations fail before mutation.

Redemption replay validates the complete result against the holding, canonical amount/balance fields and original valuation/rounding rule. A supplied approval amount must still match that original settlement. Incomplete, malformed or contradictory results are conflicts and never trigger another credit.

Purchases persist their complete original SDK result in `subscribeResult` inside the same transaction. Replay verifies that result against the holding and returns the original balance and source account. A missing or corrupt original purchase result is a conflict rather than a reconstructed result.

Committed investment results are replayed before resolving the current checking account or applying the current product minimum. These mutable eligibility checks run inside the transaction only for new effects. A later account classification or product change cannot erase the original result.

This simulator accepts an explicit estimated market value. It does not implement market-data ingestion, fund shares, NAV pricing or interest accrual. Introducing those products requires separate units, pricing timestamps, sources and product-specific calculations rather than interpreting cash principal as fund shares.

## Current schema only

`pnpm db:push` synchronizes the current Prisma schema. `pnpm db:reset` recreates the simulated dataset and seeds the current model. There is no Float conversion, basis-point conversion, historical JSON rewrite or financial migration command. Older databases must be replaced with the current demo schema rather than silently interpreted under new units.

Stop the application before an explicit demo reset. The reset removes the workspace-contained SQLite file and its WAL/journal sidecars before creation, preventing partial WAL state from producing a malformed database. Normal schema synchronization does not replace the dataset.

Transfer replay accepts only the current request digest and a verified committed receipt linked to its ledger. A receipt-less ledger or obsolete fingerprint fails closed without moving money. Current command receipts, restart recovery and immutable Pi event journals remain necessary runtime guarantees.

## Verification

Tests cover rate precision below one basis point, estimates at 18 fractional digits, HALF_UP half-cent boundaries, signed INT64 limits, original receipt replay after quote changes, approval/execution agreement, total-loss settlement, numeric input rejection, and missing or corrupt current execution evidence. Prior migration tests were removed with the unsupported migration implementation.
