# Prisma Data Layer — Context

## Intent

Owns the **SQLite data contract + demo seed** for the AI Banking Agent demo: the Prisma schema
(`schema.prisma`) and the idempotent, **non-destructive** demo seed (`seed.ts`). All banking data is
simulated — demo sandbox, no real bank/money.

## Files

- `schema.prisma` — the Prisma schema (SQLite). Defines every table, relation and index.
- `seed.ts` — idempotent, non-destructive demo seed. First takes a best-effort rolling backup of the
  resolved SQLite file to `<dbFile>.backup.db` (never fatal), then rebuilds the demo dataset — every
  money value authored in integer cents — and prints the balance reconciliation + per-table row counts
  to stdout. Run via `npm run db:seed` (== `tsx prisma/seed.ts`) or `npx prisma db seed` (wired through
  `package.json`'s `"prisma": { "seed": ... }`); also run by `npm run db:reset`.

There is **no `migrations/` dir** — the schema is applied with `prisma db push` (SQLite demo, no
migration history).

## API Surface

Prisma models (see `schema.prisma` for exact fields):

- `User` — demo user; roots to accounts, cards, contacts, subscriptions, holdings, budgets, sessions,
  scheduledTasks, auditLogs, securityEvents.
- `Account` / `Transaction` — checking/savings balances and ledger (signed `amount`, anomaly flags).
- `Contact`, `Card` + `CardLimit`, `Subscription`, `Budget` (`idempotencyKey` unique — plan-replay key).
- `InvestmentProduct` / `InvestmentHolding` — products and user holdings (`InvestmentHolding` carries
  `idempotencyKey` unique — plan-replay key).
- `AgentTask` / `AgentTaskNode` — planner task DAG (nodes store `args`/`output`/`dependencies` as JSON
  text). Both carry `executionToken` + `executionClaimedAt` — the DB-level exactly-once execution claim.
- `ScheduledTask` — future reminders/payments/transfers (`idempotencyKey` unique — plan-replay key).
- `AuditLog` / `SecurityEvent` — append-only audit + security records.
- `AgentSession` — per-session serialized agent state (`stateJson`).
- `PendingAction` / `MfaChallenge` — two-phase YELLOW/RED confirmation + mock MFA. `PendingAction`
  carries `taskId`/`nodeId` (owning plan + node) persisted at creation for plan-level revocation.
- `ExecutionReceipt` — the committed-fact record of a gated side effect, unique on `(userId, key)`;
  stores the ORIGINAL result (`resultJson`) + `requestDigest` so a replay returns the committed result.

## Seed Data (`seed.ts`)

- Anchored to the demo clock: **DEMO_NOW = 2026-09-25 12:00 local** (September 2026 = "current month",
  August 2026 = "last month" for 环比/trend). Every date is built from LOCAL `new Date(...)` components;
  `seed.ts` deliberately does **NOT** import `lib/date` and never calls `Date.now()`.
- **Money is CENT-EXACT.** Every monetary value is authored as an integer number of CENTS (分) through
  the local `yuan(cents)` helper, so each persisted value is a realistic two-decimal CNY `number` in its
  `Float` column — some round (`68.00`, `18,000.00`), some with real 分角 (`-300.60`, `5178.36`). All
  reconciliation arithmetic runs in cents, so totals never accumulate float drift.
- **Balance reconciliation model** — each account has an explicit OPENING balance and the STORED balance
  is `opening + Σ(that account's seeded transactions)`:
  - `acct_checking` (活期账户): opening **¥11,208.18** + ledger **¥12,371.82** = stored **¥23,580.00**.
  - `acct_savings` (储蓄账户): opening **¥50,000.00** + ledger **¥0.00** (no seeded transactions) =
    stored **¥50,000.00**.
  Checking has 214 DEBIT expenses and 18 CREDIT income/refund rows; savings has no ledger rows.
  The opening checking balance is derived from the chosen ¥23,580 demo balance and the full signed
  ledger. Seed guards require integer cents, unique ids, a nonnegative opening and no future
  transaction beyond the demo clock. Each run prints the reconciliation.
- **Canonical stable ids** are preserved for the ids the app + E2E suite address by name (`user_liming`,
  `acct_checking`/`acct_savings`, `card_credit`/`card_debit`, `contact_zhangwei/wangfang/mama/lihua`,
  `prod_wenjiana/b/jinrong/huobi`, `tx_anomaly_apple`, the `tx_sep_*`/`tx_aug_*` ledger ids).
  `tests/helpers/fixtures.ts` is an **independent, hand-maintained mirror** of the same demo world for
  the non-E2E Vitest suite — it is NOT generated from this seed and is NOT required to match these exact
  cent values (the stable ids / categories / merchants / condition thresholds are what must stay aligned).
- Row counts: `User 1 · Account 2 · Transaction 232 (180 fractional amounts) · Contact 8 · Card 2 · CardLimit 4 · Subscription 6 ·
  InvestmentProduct 4 · InvestmentHolding 3 · Budget 3 · ScheduledTask 2`.
- **Idempotent**: user + investment products are `upsert`ed by stable id; every user-scoped child table is
  scoped-`deleteMany({ where: { userId } })`'d then recreated in FK-safe order — deletes are confined to
  the DEMO USER (and the stable product ids), never another user's rows or unrelated tables. Re-running
  converges to the same dataset.
- Uses the shared client singleton `lib/db/client` (`prisma` + `resolveDatabaseUrl`), which resolves
  `DATABASE_URL` with a cwd-relative absolute fallback — so the seed runs even though `tsx` does not
  auto-load `.env`.

### Backup & Re-seed Procedure

- Before writing anything, `seed()` copies the resolved SQLite file to **`<dbFile>.backup.db`** in the
  same directory (a single rolling backup, overwritten each run). It is **best-effort and never fatal**:
  it strips the leading `file:` + any `?...` query, skips an empty / `:memory:` / not-yet-existing DB,
  resolves a relative SQLite path against the `prisma/` dir (mirroring Prisma's schema-relative
  resolution), and only `console.warn`s on any failure. The `.db` suffix keeps it git-ignored via the
  root `*.db` rule.
- **`npm run db:seed`** = back up the current DB, then rebuild the demo dataset (this seed).
- **`npm run db:reset`** = `tsx scripts/db-push.ts --force-reset` (drop + recreate the schema), then
  `tsx prisma/seed.ts` (backup + reseed). A reset is a **rebuild, not a repair** — consistency is never
  restored by wiping/re-seeding.

## Design Decisions

- **Six months of demo data (April–September 2026).** September ordinary expenses are
  **¥6,937.05**, including **娱乐 ¥2,843.99** (> ¥2,000); August ordinary expenses are **¥7,375.54**.
  The Apple Store **¥6,999.00** anomaly remains a separate flagged row. Salary, project bonus and
  refund are CREDIT rows and are excluded from expense/category totals. No outgoing transfer is
  seeded on Sep 25, so the first small transfer remains YELLOW.
  The independent unit-test fixtures retain their original ¥5,800 sample; they are not the demo seed.
- Money is signed CNY (`Float`); negative = expense/outflow, positive = income/inflow. Seed values are
  authored in integer cents and stored via `yuan()`; direction follows the amount sign (DEBIT/CREDIT).
- SQLite has no native enums — every enum-like/status field is a `String` (allowed values documented at
  the top of `schema.prisma`). JSON-ish payloads are JSON text in `String` columns.

## Concurrency & Idempotency (schema-level)

All new fields below are **optional/nullable**, so existing rows and tests keep working and the
`prisma db push` workflow is unchanged (no migration file).

- **Exactly-once execution claims** — `AgentTask.executionToken`/`executionClaimedAt` claim the PLAN
  executor (so two concurrent resume/retry calls cannot both run a plan);
  `AgentTaskNode.executionToken`/`executionClaimedAt` claim a single node's side effect (so concurrent
  executors cannot double-execute a node). The winning executor sets a unique token; a concurrent
  executor that cannot claim it must NOT run. `NULL` = unclaimed.
- **Plan-replay keys** — Budget uses `@@unique([userId, idempotencyKey])`; `ScheduledTask.idempotencyKey` and
  `InvestmentHolding.idempotencyKey` are `@unique`; the plan key is `nxe:<planId>:<nodeId>`, so a REPLAYED
  plan node replays its existing reservation/scheduled task/holding instead of duplicating it. SQLite
  allows multiple `NULL`s in a UNIQUE index, so rows created outside the planner (and all pre-existing
  rows) are unaffected.
- **Plan-level revocation** — `PendingAction.taskId`/`nodeId` (nullable) persist the owning plan
  (`AgentTask.id`) + node (`AgentTaskNode.nodeId`) at CREATION, so a plan-level cancel can revoke EVERY
  associated operation even when the node's `output` JSON was never written / was overwritten.
- **Indexes** — added `PendingAction @@index([taskId])` and `AgentTaskNode @@index([taskId, nodeId])`
  (the latter also supports the exactly-once node claim lookups) alongside the existing indexes.
- **Committed-fact record (`ExecutionReceipt`)** — `id`, `userId`, `key`, `toolName`, `requestDigest`,
  `resultJson` (JSON text of the ORIGINAL tool result), `txId` (the ledger `Transaction` id, nullable),
  `createdAt`, with `@@unique([userId, key])`. It is the durable proof that a gated side effect under a
  given execution identity (`userId` + `key`) has committed: a repeat with the SAME identity and SAME
  `requestDigest` returns the stored ORIGINAL `resultJson`; the SAME identity with a DIFFERENT digest is
  a `CONFLICT`.
- **Plan-ownership generation (`AgentTask.generation Int @default(0)`)** — the plan-execution generation
  stamped on claim and emitted on `plan_update`; used for execution-right fencing.
- **Execution lease (`PendingAction.executionLeaseOwner String?` + `executionLeaseExpiresAt DateTime?`)** —
  the persisted LEASE of the confirm/verify continuation applying an action side effect
  (`EXECUTION_LEASE_TTL_MS = 120000`, a code constant in `agent/confirmation-recovery.ts`); it
  distinguishes a still-running continuation from a genuine wedge. `NULL` = no active lease.
- **Write-once recovery audit (`AuditLog.dedupeKey String? @unique`)** — makes a recovery audit
  idempotent: a repeat recovery with the same `dedupeKey` (e.g. `exec:<ledgerKey>`) never
  double-records. SQLite UNIQUE allows multiple `NULL`s, so key-less rows are unaffected.
- **Terminal reconciliation status** — `PendingAction.status` also includes `needs_reconciliation`
  (an out-of-band human-settled UNKNOWN outcome) alongside
  `pending` | `confirmed` | `awaiting_mfa` | `executed` | `failed` | `cancelled`.

### Schema Evolution & Legacy-Data Compatibility

Every field/model above is **additive** — new nullable columns and new tables only; no existing column
is changed or removed. The schema is applied exclusively with **`prisma db push`** (there is **no
`migrations/` directory**), and a push leaves **existing data valid** (new columns default to
`NULL`/`0`). Historical `PendingAction`/ledger rows that lack an `ExecutionReceipt` are still recognized
as already-posted via the legacy deterministic ledger id (`idempotentTransferTxId`), so a receipt is not
required for them to be treated as committed. Data consistency is **never** restored by clearing or
re-seeding — a reset is not a repair.

## Constraints

- Keep `schema.prisma` in sync with `lib/contracts/` (risk levels, audit status, permission tiers);
  field names here are the source of truth for `lib/db` repositories. Never fork a contract type here.
- Run Prisma commands from the repo **root**: `npx prisma generate` · `npx prisma db push` ·
  `npm run db:seed`. SQLite `DATABASE_URL` is `file:./dev.db`, resolved relative to this dir →
  `prisma/dev.db` (git-ignored). Never target the shared dev DB from tests (they use `prisma/test.db` /
  `prisma/e2e.db`).
- File-size rule: keep the schema + seed readable; split only if they exceed ~1000 lines.

## Notes for Agents

- The Prisma client singleton and typed repositories live in **`lib/db`** (`lib/db/client.ts`,
  `lib/db/repositories/*`) — those own all runtime data access. This directory owns the schema + seed only.
- `tests/helpers/fixtures.ts` is an **independent mirror** of the demo dataset used by the Vitest suite;
  it is hand-maintained, is NOT derived from `seed.ts`, and does not need to match these exact cent
  values — keep the stable ids / categories / thresholds aligned instead.
