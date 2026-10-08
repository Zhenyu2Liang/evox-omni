# tests/unit/lib — `lib` unit specs

## Intent

Unit specs for the deterministic cores of the shared kernel (`lib/`): identity/dedup primitives
and the ownership-aware pending-action persistence primitives. Pure-logic specs here need no DB and
no LLM; DB-backed specs run against the isolated test SQLite (`../helpers/db`). Specs stay load-safe
(no top-level Prisma construction outside DB-backed cases).

## API Surface

- `pendingAction.claim.test.ts` — **DB-backed**. Covers `lib/db/repositories/pendingAction`:
  `claimPendingAction` exactly-once `pending → confirmed` atomic claim (exercised both directly and
  through the `@/lib/db/repositories` barrel), the `from`-set match, `userId`/`sessionId` ownership
  scoping, `setPendingActionStatus`, and `getPendingActionOwnership` (unknown id → `null`). Uses a
  unique `sessionId` per test and `resetDatabase` in `beforeEach`.
- `ledger-keys.test.ts` — **pure, no DB, no LLM**. Covers the de-dup scope identity helpers in
  `@/lib/ledger`:
  - `nodeExecutionKey(taskId, nodeId)` — frozen `nxe:<taskId>:<nodeId>`; deterministic; plan-scoped
    (different `taskId` never merges) and node-scoped (different `nodeId` never merges).
  - `idempotentTransferTxId(userId, idempotencyKey)` — frozen `txidem_` + first 32 hex chars of
    `sha256("<userId>\u0000<key>")`, asserted against an independent `node:crypto` computation and
    the `/^txidem_[0-9a-f]{32}$/` pattern; distinct per `(userId, key)`.
  - A namespace cross-check proving `nxe:` and `txidem_` keys can never collide.
- `execution-receipt.test.ts` — **pure, no DB, no LLM**. Covers the committed-fact identity helpers in `@/lib/ledger`: `executionReceiptId(userId, key)` (frozen `rcpt_` + first 32 hex of `sha256("<userId>\u0000<key>")`) and `requestDigest(parts)` (stable sha256 hex of the KEY-SORTED canonical JSON — insertion-order independent, sorts nested objects, normalizes an absent `undefined` part like explicit `null`), each checked against an independent `node:crypto` reference plus a `rcpt_`/`txidem_` collision cross-check.
- `prisma-cli-env.test.ts` — **pure, no DB, no LLM**. Locks the shared schema-engine env policy in `@/lib/prisma-cli-env`: `SCHEMA_ENGINE_RUST_LOG === 'info'`, the MUTATING `pinSchemaEngineLogging(env)` (forces `RUST_LOG=info`, `RUST_BACKTRACE` default `1`/preserved if set, mutates and returns the SAME object), and the NON-mutating `prismaCliEnv(env)` (returns a NEW env, leaves its input untouched, carries every other ambient key through).

## Constraints

- Assert through public module paths (`@/lib/ledger`, `@/lib/db/repositories/pendingAction`) — never
  re-implement the code under test.
- Offline & deterministic: no network, no fake timers, `now` injected where relevant.
- DB-backed specs reset+seed via `../helpers/db.resetDatabase()` in `beforeEach`; pure specs must not
  touch the DB.
- Import frozen types from `@/lib/contracts/*`; never redeclare. Keep files ≲ ~1000 lines.

## Routing Table

- `./pendingAction.claim.test.ts` → PendingAction atomic-claim persistence primitives (DB-backed)
- `./ledger-keys.test.ts` → plan-node + transfer-ledger de-dup scope identity keys (pure)
- `./execution-receipt.test.ts` → committed-fact receipt id + canonical request digest (pure)
- `./prisma-cli-env.test.ts` → schema-engine RUST_LOG pinning policy, mutate vs copy (pure)
