# Wealth Management Products: Net Value and Units

**English** | [简体中文](../cn/investments.md)

Wealth management holdings are recorded on a "net value + units" basis.
Principal is not an input basis for redemption.
Purchases and redemptions go only through units and net value; returns are calculated as the difference between cost and market value.

## Terms and Units

| Name | Storage | Precision |
| --- | --- | --- |
| Net value `netValuePerUnit` | Canonical decimal TEXT | 4 decimal places, minimum tick 0.0001 |
| Units `shares` | Canonical decimal TEXT | 6 decimal places |
| Holding market value `marketValue` | Canonical decimal TEXT (not rounded) | Exact product of `shares × 净值` |
| Remaining holding cost | BigInt cents (`principalAmountMinor`) | Booked RMB cents |
| Credited amount, fees, realized return | BigInt cents | Booked RMB cents |
| Holding return rate | Canonical decimal TEXT | Dimensionless ratio, displayed as a percentage |

Net value is given by simulated data and does not grow automatically with real time.
When a product has no net value, both purchases and redemptions are rejected.
For financial units and general rounding rules, see [financial-values.md](financial-values.md).

## Precision and Rounding

| Step | Formula | Rounding |
| --- | --- | --- |
| Purchase units conversion | `申购金额 ÷ 净值` | FLOOR to 6 decimal places |
| Redemption-by-amount units conversion | `金额 ÷ 净值` | FLOOR to 6 decimal places |
| Holding market value | `份额 × 净值` | Not rounded |
| Redemption credited amount | `份额 × 成交净值` | HALF_UP to cents, rounded exactly once |
| Redemption cost consumed | `剩余成本 × 赎回份额 ÷ 总份额` | HALF_UP to cents |
| Realized return | `到账金额 − 该次消耗成本` | Booked cents subtracted, may be negative |
| Holding return rate | `持仓收益 ÷ 剩余持仓成本` | 18 decimal places; undefined when cost is zero |

Cost is deducted in proportion to units and is conserved: the sum of redeemed cost and remaining cost always equals the original cost.

Valuation on read is derived solely by `banking-sdk/investment.ts#holdingValuation` from `份额 × 最新净值`, with no rounding.
The holding list, holding card, product tile, WeChat output, and total assets all share this single derivation.
`estimatedMarketValue` is a column snapshot left at write time.
When units and net value are both present, this snapshot does not participate in valuation.

When there are no available units or the product has not published a net value, the valid historical book valuation is retained.
The page is marked "Historical book valuation, pending verification."
Only when the historical valuation is also missing does it fall back to cost, marked "Insufficient historical data."
In this case, holding return, holding return rate, and cumulative return are not provided.

Redemption fees are waived per simulation rules.
`feeAmount` is always `0.00`, and `feeRule` is always `SIMULATED_NONE`.
The contract retains the fee field, and the confirmation card must display the fee basis.

The residual from flooring purchase units is less than the amount corresponding to one unit unit (`0.000001 份`) and is included in cost.
Therefore, immediately after a purchase, the holding return is approximately `0.00`.

The above conversions are BigInt fixed-point pure functions, located in `banking-sdk/net-value.ts`.
The constants are `NET_VALUE_DECIMALS = 4`, `SHARE_DECIMALS = 6`, and
`REDEMPTION_FEE_RULE = 'SIMULATED_NONE'`.
The exported functions are `floorToShares`, `sharesFromAmount`, `marketValueFromShares`,
`settlementFromShares`, `redeemedCostMinor`, `remainingSharesOf`, and `profitRateOf`.
This module performs no reads or writes, only conversions.

## Return Basis

- Holding return is **unrealized return**: `持仓市值 − 剩余持仓成本`.
- Holding return rate is `持仓收益 ÷ 剩余持仓成本`; this value is undefined when cost is zero.
- Realized return accumulates with each redemption: `到账金额 − 该次赎回消耗的成本`, and may be negative.
- Cumulative return is `已实现收益 + 持仓收益`.
- **Additional purchase amounts are never counted as return**: purchases only increase cost and units.

Holding return and holding return rate are signed values: a losing holding is negative. On display, `lib/decimal.ts#signedRateToPercent` converts them to percentages, without rounding and without truncating the negative sign. The non-negative gate applies only to booked amounts and to non-negative `annualYieldRate`.

Pages and cards must be marked "Returns are simulated estimates, no principal guarantee is promised."

## Purchases: New and Merged

When a holding already exists for the same product, an additional purchase is merged into the same holding.
Cost and units increase together, and the holding status remains `HOLDING`.
Each purchase leaves a record in the holding's transaction details.
The record includes time, amount, units obtained, execution net value, and net value date, so the cost basis can be traced transaction by transaction.
When the product has no net value, purchases are rejected.

## Redemption Basis

A redemption must explicitly specify one of three bases:

- `SHARES`: redeem by units; a positive number of units must be given and must not exceed the held units.
- `AMOUNT`: redeem by amount; units `= FLOOR(金额 ÷ 净值, 6 位小数)`.
  If the converted units are zero or the amount exceeds the current market value, the redemption is rejected and is never silently enlarged into a full redemption.
- `ALL`: redeem all units and close the holding; no units or amount parameters are accepted.

Mixing bases (for example, giving an amount together with units) is always rejected.
When the user mentions only an amount, it must first be clarified whether they mean "amount" or "units."
The clarification is enforced by the server-side contract and does not depend on prompts.
**There is no interpretation of "redeem principal and then pay returns separately."**

A full redemption sets the holding to `REDEEMED` and books everything at once.
A partial redemption keeps `HOLDING`, and the remaining units, remaining cost, market value, and return are mutually consistent.
Once realized return is booked, it is never recalculated.

### Three-Layer Enforcement

The redemption basis and input format are enforced independently at three layers—tool, gateway, and plan—and none of these layers depends on prompts:

| Layer | Location | Behavior |
| --- | --- | --- |
| Tool | `agent/tools/investment.ts#redemptionRequest` | `mode` is a required enum `SHARES`／`AMOUNT`／`ALL`; mixed use and retired fields are rejected here |
| Tool | `agent/tools/decimal-schema.ts` | `canonicalShareCount` and `canonicalNetValue` accept only unsigned canonical decimal text |
| Gateway | `security/security-gateway.ts` | `redemptionMode` and `assertRedeemForm` revalidate the basis and mint the snapshot |
| Plan | `planner/dag.ts` | `redeemModeProblem` rejects redemption nodes with a missing, unknown, or mixed basis |

`redeemAmount` is not an available parameter; if it appears, `VALIDATION` is thrown and the user is prompted to reselect the basis.
A missing or invalid `mode` likewise throws `VALIDATION`, with the message
`赎回需要明确口径：请确认按「份额」还是按「金额」赎回`.
Plan validation returns the same problem as a node error.

## Confirmation and Execution Consistency

The confirmation snapshot contains 5 fields.
These are `expectedPositionVersion`, `expectedShares`, `expectedNetValue`, `expectedNetValueDate`, and `expectedSettlementAmount`.
The snapshot is minted by the gateway calling the same set of functions in `banking-sdk/net-value.ts`, so it cannot diverge from execution settlement.
`expectedPositionVersion` corresponds to the version of the entire holding.
Additional purchases, partial redemptions, and full redemptions all increment `positionVersion`.
If the version does not match at execution time, the request is rejected, preventing missed holding changes.
Pending authorizations that lack a version from before the upgrade must be reinitiated and reconfirmed.

At execution time, the product's latest net value and the holding units are re-read within the write transaction.
If any of the following occurs, the old authorization is rejected and `CONFLICT` (`净值或持仓已变化，请重新确认`) is thrown:

- The current units do not match `expectedShares`.
- The current net value or net value date does not match the snapshot.
- The credited amount recalculated from current data does not match `expectedSettlementAmount`.

The rejection occurs before any write; the tool fails with `CONFLICT` and performs zero writes.
Balances, units, and transaction records all remain unchanged.
The system must not silently execute at the new net value.
The authorization has been confirmed and cannot be retried; the user must reinitiate the redemption, and it can be executed only after the server mints a new snapshot.

## Idempotency and Concurrency

Execution identity follows the server-owned action or plan-node key.
Replaying the same key returns the original result (original units, original net value, original credited amount) without deducting or crediting again.
Subsequent changes in net value do not affect the persisted receipt; receipt replay takes precedence over mutable reads.
Different keys acting on an already closed holding always conflict.
Redemption deductions are written conditionally on the old units and `HOLDING` status.
Of two concurrent redemptions, only one succeeds; there is no overselling or overpayment.

## Display: Pages, Cards, and WeChat

`components/banking/HoldingFacts.tsx` is the single rendering source for holding facts.
The holding card passes in `layout="card"`, and the product tile passes in `layout="tile"`.
Nine items are always displayed: holding units, latest net value, net value date, holding market value,
remaining holding cost, holding return, holding return rate, cumulative return, and realized return.
All nine items are always rendered; cumulative return and realized return are not hidden just because no redemption has occurred for the holding.
When data is insufficient, "Insufficient historical data" is shown, with no zero filling.
`valueBasis` determines the label: `MIGRATED_ESTIMATE` is labeled "Estimated,"
`HISTORICAL_DATA_INSUFFICIENT` is labeled "Insufficient historical data," and `NET_VALUE` has no additional label.
The holding card must provide a return-basis explanation and the disclaimer "Returns are simulated estimates, no principal guarantee is promised."
Units retain 6 decimal places, net value retains 4 decimal places, and the net value date is displayed in UTC+08:00.

After an investment write completes, the conversation investment card displays the holding projection re-read after submission.
`agent/tools/investment.ts#withHoldings` calls `listHoldings` after submission to re-read the current holding.
`agent/card-emitter.ts` accordingly returns the receipt first, then appends the same investment holding card.
When re-reading is unavailable, only the receipt is returned; committed writes are not rolled back, and no empty holding list is fabricated.

The redemption confirmation card is rendered by `components/chat/cards/ActionDetails.tsx`.
The card displays the snapshot fields and the settlement formula "Credited amount = redeemed units × execution net value."
When the fee basis is `SIMULATED_NONE`, it also includes "The simulation environment does not charge redemption fees; redemption fee ¥0.00."
The card also states that execution stops and reconfirmation is required if the net value, units, or credited amount changes.

The WeChat channel is output line by line by `channels/weixin/presentation.ts` with the following set of facts:
holding units, latest net value (including net value date), holding market value, remaining holding cost, holding return, holding return rate, and cumulative return.
When the net value is empty or history is insufficient, "Insufficient historical data" is output.
The holding list ends with the same disclaimer sentence.

## Historical Holdings and Upgrade

Legacy holdings without units are derived from the latest net value.
The basis is `shares = FLOOR(市值 ÷ 净值, 6 位小数)`, and the economic value drift of any single transaction must be less than `0.01 元`.
When the product has no net value, no data is fabricated.
On read, the valid historical valuation is retained and labeled "Pending verification."
Missing units, net value, and return are still displayed as "Insufficient historical data."
Holdings derived from legacy data are marked as estimates on `sharesEstimated`.
On read, `valueBasis` is `MIGRATED_ESTIMATE`; the page, card, and WeChat output are labeled "Estimated," and market value is still derived according to `shares × 净值`.
The flag is written only by the backfill script; original purchases, aggregated purchases, and demo seed holdings keep the default false value, with `valueBasis` being `NET_VALUE`.
Holdings that have already been backfilled are not rewritten again by the script.

`estimatedMarketValue` is only a snapshot.
When units and net value are both present, it is derived by `shares × latestNetValuePerUnit`.
Historical snapshots cannot be used as the execution basis for purchases or redemptions.

The upgrade is performed in order:

1. Run `node scripts/db-backup.mjs`; the snapshot is written to `logs/db-backups/`.
2. Execute `pnpm db:push` to synchronize the net value and units fields.
3. Check and fill in missing simulated net values according to [Upgrade Steps](development.md#database-backup-and-net-value-share-upgrade).
4. Run `node scripts/investment-share-backfill.mjs` as a dry run and check the results.
5. Add `--apply` to write units and mark the holding as estimated.

The script is read-only by default and only processes holdings that are `HOLDING` and have no units; the dry run explains that derived units will be marked as estimated.
If the drift of any single transaction reaches `0.01 元`, the script writes nothing and exits with a non-0 status.
Even if the drift is less than `0.01 元`, the quantile rounding result must remain unchanged.
When there are holdings that cannot be derived, the exit code is `2`, and the upgrade must not be declared complete on that basis.
The backfill uses the original cost, historical valuation, and net value as concurrency checks.
If any record changes, the entire batch of writes is rolled back.
When the original receipt recorded the credited amount and redemption cost, the backfill also restores the realized return.
The original receipt content remains unchanged; historical units or execution net value are not fabricated.
If a receipt is missing an amount, is corrupted, or conflicts with the booked return, the entire batch stops.

When a rollback is needed, first stop all database connections.
Check the source database recorded in `.json` next to the snapshot, and handle the WAL and SHM side files for that target.
Overwrite the corresponding database with the snapshot, then restore the matching code version and generate the client.
For the complete commands and backup directory format, see
[development.md](development.md#database-backup-and-net-value-share-upgrade).
