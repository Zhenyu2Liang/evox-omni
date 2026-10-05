# Prisma Data Layer — Context

## Intent

Owns the **SQLite data contract + demo seed** for the AI Banking Agent demo: the Prisma schema
(`schema.prisma`) and the idempotent demo seed (`seed.ts`). All banking data is simulated —
demo sandbox, no real bank/money.

## Files

- `schema.prisma` — the Prisma schema (SQLite). Defines every table, relation and index.
- `seed.ts` — idempotent demo seed. Run via `npm run db:seed` (== `tsx prisma/seed.ts`) or
  `npx prisma db seed` (wired through `package.json`'s `"prisma": { "seed": ... }`); also run by
  `npm run db:reset`. Summarizes per-table row counts to stdout.

There is **no `migrations/` dir** — the schema is applied with `prisma db push` (SQLite demo, no
migration history).

## API Surface

Prisma models (see `schema.prisma` for exact fields):

- `User` — demo user; roots to accounts, cards, contacts, subscriptions, holdings, budgets, sessions,
  scheduledTasks, auditLogs, securityEvents.
- `Account` / `Transaction` — checking/savings balances and ledger (signed `amount`, anomaly flags).
- `Contact`, `Card` + `CardLimit`, `Subscription`, `Budget` (`idempotencyKey` unique — plan-replay key).
- `InvestmentProduct` / `InvestmentHolding` — products and user holdings.
- `AgentTask` / `AgentTaskNode` — planner task DAG (nodes store `args`/`output`/`dependencies` as JSON
  text). Both carry `executionToken` + `executionClaimedAt` — the DB-level exactly-once execution claim.
- `ScheduledTask` — future reminders/payments/transfers (`idempotencyKey` unique — plan-replay key).
- `AuditLog` / `SecurityEvent` — append-only audit + security records.
- `AgentSession` — per-session serialized agent state (`stateJson`).
- `PendingAction` / `MfaChallenge` — two-phase YELLOW/RED confirmation + mock MFA. `PendingAction`
  carries `taskId`/`nodeId` (owning plan + node) persisted at creation for plan-level revocation.

## Seed Data (`seed.ts`)

- Anchored to the demo clock: **DEMO_NOW = 2026-09-25 12:00 local** (September 2026 = "current month",
  August 2026 = "last month" for 环比/trend). Every date is built from LOCAL `new Date(...)` components;
  `seed.ts` deliberately does **NOT** import `lib/date` and never calls `Date.now()`.
- Reuses the **canonical stable ids** from `tests/helpers/fixtures.ts` (`user_liming`,
  `acct_checking`/`acct_savings`, `contact_zhangwei/wangfang/mama/lihua`, `prod_wenjiana/b/jinrong`,
  `tx_anomaly_apple`) so the app, tests and seed agree.
- Row counts: `User 1 · Account 2 · Transaction 30 · Contact 4 · Card 2 · CardLimit 1 · Subscription 4 ·
  InvestmentProduct 4 · InvestmentHolding 1 · Budget 1 · ScheduledTask 2`.
- **Idempotent**: user + investment products are `upsert`ed by stable id; every user-scoped child table is
  scoped-`deleteMany`'d then recreated in FK-safe order. Re-running converges to the same dataset.
- Uses the shared client singleton `lib/db/client` (`prisma`), which resolves `DATABASE_URL` with a
  cwd-relative absolute fallback — so the seed runs even though `tsx` does not auto-load `.env`.

## Design Decisions

- **"本月消费 ≈ ¥5,800" EXCLUDES the anomaly.** September 2026 ordinary expense transactions sum to
  exactly **¥5,800** with **娱乐 = ¥2,680** (so Test 11 "若本月娱乐 > 2000" holds). The Apple Store
  **¥6,999** anomaly (`tx_anomaly_apple`, category 购物, channel CARD, `2026-09-20 18:32`,
  `isAnomaly: true`) is a **separate, additional** row — NOT part of the ¥5,800.
  → **`analyze_spending` (banking-sdk) must therefore not fold anomalies into the 本月消费 total** (this
  matches `tests/helpers/fixtures.ts` `MONTHLY_SPEND_TOTAL = 5800`, which is built separately from
  `ANOMALY_TRANSACTION`).
- Money is signed CNY (`Float`); negative = expense/outflow, positive = income/inflow. Seeded
  transactions are expense-only (`direction: 'DEBIT'`).
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
- **Plan-replay keys** — `Budget.idempotencyKey` and `ScheduledTask.idempotencyKey` are `@unique`; the
  value is `<planId>:<nodeId>`, so a REPLAYED plan node replays its existing reservation/scheduled task
  instead of duplicating it. SQLite allows multiple `NULL`s in a UNIQUE index, so rows created outside
  the planner (and all pre-existing rows) are unaffected.
- **Plan-level revocation** — `PendingAction.taskId`/`nodeId` (nullable) persist the owning plan
  (`AgentTask.id`) + node (`AgentTaskNode.nodeId`) at CREATION, so a plan-level cancel can revoke EVERY
  associated operation even when the node's `output` JSON was never written / was overwritten.
- **Indexes** — added `PendingAction @@index([taskId])` and `AgentTaskNode @@index([taskId, nodeId])`
  (the latter also supports the exactly-once node claim lookups) alongside the existing indexes.

## Constraints

- Keep `schema.prisma` in sync with `lib/contracts/` (risk levels, audit status, permission tiers);
  field names here are the source of truth for `lib/db` repositories. Never fork a contract type here.
- Run Prisma commands from the repo **root**: `npx prisma generate` · `npx prisma db push` ·
  `npm run db:seed`. SQLite `DATABASE_URL` is `file:./dev.db`, resolved relative to this dir →
  `prisma/dev.db` (git-ignored).
- File-size rule: keep the schema + seed readable; split only if they exceed ~1000 lines.

## Notes for Agents

- The Prisma client singleton and typed repositories live in **`lib/db`** (`lib/db/client.ts`,
  `lib/db/repositories/*`) — those own all runtime data access. This directory owns the schema + seed only.
