# Dashboard read model (`GET /api/dashboard`)

## Intent

The single HTTP read model behind a dashboard/overview refresh: total assets, checking balance,
credit available and current-month spend, scoped to the fixed demo workspace. Pure read (GREEN): it
persists nothing, decides no permission and acquires no lease. All money maths lives in
`@/banking-sdk`; this route only resolves the identity and serializes.

## HTTP contract

`route.ts:17-25` is the whole handler:

```ts
export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const userId = resolveUserId();
    const data: DashboardSummary = await banking.dashboard.getDashboardSummary(userId);
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}
```

- **No query params.** `_req` is unused, so `?userId=`/`?sessionId=` is ignored, never trusted.
- **Identity**: `resolveUserId()` (`_lib/session.ts:7-9`, `getConfig().demoUserId || DEFAULT_DEMO_USER_ID`). No cookie, no `requireIdentity`, no session row, no ownership check — an anonymous `fetch('/api/dashboard')` succeeds.
- **Success**: HTTP `200` `{ "ok": true, "data": <DashboardSummary> }` (`_lib/http.ts:35-37,58-60`).
- **Failure**: `{ "ok": false, "error": { "code": string, "message": string } }` with the frozen status map (`_lib/http.ts:19-32`, `?? 500`; non-`AppError` → `INTERNAL`/`500`/`"Internal error"`).
- **Pass-through**: the SDK object is serialized unchanged — no field projection, renaming, rounding or narrowing at this edge. `route.ts:27` re-exports the `DashboardSummary` type only.

## Serialized `DashboardSummary` (`banking-sdk/types.ts:726-741`)

Every money field is a **JSON string**, never a number:

| key | JSON type | value |
| --- | --- | --- |
| `totalAssets` | string (`DecimalAmount`) | cash + unrounded holding market values, e.g. `"96671.1199992525"` |
| `checkingBalance` | string (`MoneyAmount`) | 2-dp cents, e.g. `"23580.00"` |
| `creditAvailable` | string (`MoneyAmount`) | 2-dp cents, e.g. `"18000.00"` |
| `monthSpend` | string (`MoneyAmount`) | current-month positive spend |
| `month` | string | `"YYYY-MM"` (business calendar) |
| `recentTransactions` | array | up to 5 `TransactionView` (`id`, `accountId`, `amount`, `currency`, `direction`, `category`, `merchant`, `channel?`, `remark?`, `counterpartyId?`, `occurredAt` epoch ms, `isAnomaly`, `anomalyReason?`) |
| `latestAnomaly` | object or `null` | `AnomalyItem` (`transaction`, `reason`, `severity`, `acknowledged?`) |
| `asOf` | number | epoch ms (`demoNow()`) |

## Asset / credit computation (`banking-sdk/dashboard.ts:23-52`, verbatim)

```ts
const [totalAssets, checking, cardRows, analysis, recentTransactions, anomalies, holdingRows] = await Promise.all([
  accounts.getTotalBalance(userId),
  accounts.getCheckingAccount(userId),
  cards.listCards(userId),
  analyzeSpending(userId),
  listTransactions(userId, { limit: RECENT_TRANSACTION_LIMIT }),
  listAnomalies(userId),
  investments.listHoldings(userId, 'HOLDING'),
]);

// Only UNREPLACED credit counts. `replaceCard` leaves the `LOST` source card (with its
// `availableLimitMinor` intact) pointing at the NEW card that inherits that same limit, so summing
// every `CREDIT` row would report the same credit twice and inflate the total.
const creditAvailable = cardRows
  .filter((card) => card.type === 'CREDIT' && card.status !== 'LOST')
  .reduce((total, card) => total + (card.availableLimitMinor ?? 0n), 0n);

return {
  totalAssets: holdingRows.reduce((total, row) => addDecimal(total, holdingMarketValue(row)), centsToMoney(totalAssets)),
  checkingBalance: centsToMoney(checking?.balanceMinor ?? 0n),
  creditAvailable: centsToMoney(creditAvailable),
  monthSpend: analysis.total,
  month: analysis.month,
  recentTransactions,
  latestAnomaly: anomalies[0] ?? null,
  asOf,
};
```

Rules that follow from it:

- **A DEBIT/VIRTUAL card's settlement-account cash is counted exactly ONCE — by construction, not by dedupe.** `totalAssets` starts from `accounts.getTotalBalance(userId)` (`lib/db/repositories/account.ts:27-30`: `rows.reduce((total, row) => total + row.balanceMinor, 0n)` over `account.findMany({ where: { userId } })`) and `cardRows` never contributes cash. There is NO Set/Map dedupe, no per-card addition and no per-card subtraction anywhere: cards are only consulted for `creditAvailable`. Several cards bound to one account (or one account with two cards) therefore cannot double-count, and a `CardView.accountAvailableBalance` repeating per card is a *view* fact, not a total.
- **`checkingBalance` is ONE account, not a sum**: `accounts.getCheckingAccount` = `account.findFirst({ where: { userId, type: 'CHECKING' }, orderBy: { id: 'asc' } })` (`lib/db/repositories/account.ts:16-21`); `?? 0n` when the user has none.
- **Only non-`LOST` `CREDIT` cards contribute credit**: the filter is exactly `card.type === 'CREDIT' && card.status !== 'LOST'`, summing `availableLimitMinor` (the *available* limit, not `creditLimitMinor`). `FROZEN`/`ACTIVE`/`PENDING` credit counts; a `LOST` card replaced by a new one is excluded so the inherited limit is not counted twice. DEBIT/VIRTUAL cards, `monthlyLimit` and per-category `CardLimit` rows never enter this total.
- **`totalAssets` is unrounded decimal text**: the account subtotal is converted once with `centsToMoney` (2 dp) and each `holdingMarketValue` is added with `addDecimal` (exact, up to 18 fraction digits), so the string can carry more than 2 decimals. Display rounds HALF_UP in `components/ui/DecimalMoney`; the API never does.

## Seeded expectations (fresh `pnpm db:seed`, `prisma/seed.ts:284-381`)

- Accounts: `acct_checking` 活期账户 `****8821` `"23580.00"`, `acct_savings` 储蓄账户 `****3309` `"50000.00"`.
- Holdings (all `HOLDING`, valued `shares × latestNetValuePerUnit`): `5178.3599992525` + `8032.76` + `9880.00`.
- Therefore `checkingBalance` `"23580.00"`, `creditAvailable` `"18000.00"`, `totalAssets` `"96671.1199992525"`, `monthSpend` = 2026-09 spend, `month` `"2026-09"`.
- Any consumption/transfer/redeem changes these totals; assert relations (e.g. `totalAssets` ends with the account sum + holding values) rather than the literals after mutations.

## Consumers

No browser component fetches this route: `/overview` renders the SDK server-side
(`app/overview/page.tsx:11` `banking.dashboard.getDashboardSummary(...)` inside a
`force-dynamic` server component and passes `summary` to `AssetSummaryCard`), and `components/` never
mentions `/api/dashboard`. The only HTTP callers are the e2e harness
(`tests/e2e/helpers.ts`, `tests/e2e/acceptance.e2e.ts`, `tests/e2e/live-acceptance.e2e.ts`,
`tests/e2e/card-replace-chain.e2e-helper.ts`), which fetch it directly with plain GET requests.

## Cross-references

- Card read model (`GET /api/cards`, the `CardView` that carries `accountAvailableBalance` /
  `payableAmount`): `../cards/CONTEXT.md`.
- Envelope, status map, `parseBody`/`parseQuery`: `../_lib/CONTEXT.md`.
