# bills — Bills / 账单 Page (`/bills`)

## Intent

The **bills / spending screen**: a month-scoped view of the user's spending — category breakdown,
month-over-month trend, the transaction ledger, and the flagged anomalies. It makes the demo's
spend-analysis tools (`analyze_spending`, `detect_anomaly`) and the seeded Apple Store anomaly
visible outside the chat.

This node is a **thin Server Component** — it fetches read models directly on the server (no HTTP
hop) and composes the UI from `../components`.

## API Surface

- **Page route**: `/bills` — `page.tsx`, default-exported Server Component.
- **Read models** (server-only, via `@/banking-sdk`):
  - `banking.transaction.analyzeSpending(userId, { month })` → `SpendingAnalysis`
  - `banking.transaction.listTransactions(userId, { month })` → `TransactionView[]`
  - `banking.transaction.listAnomalies(userId)` → `AnomalyItem[]`
  - User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`). The selected `month`
    (`YYYY-MM`) is expected from the URL search param (TODO).
- **Composes** (from `../components` — referenced by name only): `MonthPicker`, `CategoryPie`,
  `MonthlyTrendChart` (Recharts), `TransactionsTable`, `AnomalyList`.

## Constraints

- **Server Component**; render chrome + `TODO: wire read model` comments — no UI logic.
- Pass only **serializable** props to client components (no `Date` — epoch ms; money is CNY `number`).
- **Read via `@/banking-sdk` only** — never import Prisma directly.
- **Never build** the composed components here; reference them from `../components` (read-only sibling).
- **Never redeclare** shared types; import them from `@/banking-sdk` / `../lib/contracts`.
- Keep the file ≲ ~120 lines.

## Dependencies

- `@/banking-sdk` (sibling — read-only): `banking.transaction.*` read functions; DTOs
  `SpendingAnalysis`, `TransactionView`, `AnomalyItem`.
- `@/lib/config` (sibling — read-only): `getConfig` (demo user resolution).
- `../components` (sibling — read-only): the charts / table / picker the page composes.
- `../api` (sibling — read-only): `GET /api/bills` used for client-side refresh.

## Routing Table

- `./page.tsx` → the `/bills` page (spend analysis + ledger + anomalies)
- `../components/` → React component library the page composes (sibling — read-only, escalate writes to parent)
- `../api/` → `GET /api/bills` refresh endpoint (sibling — read-only)
