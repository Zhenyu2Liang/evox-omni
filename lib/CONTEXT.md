# lib — Shared Kernel

## Intent

The lowest layer of the dependency graph (`lib` ← `banking-sdk` ← `agent`/`planner`/`audit` ← `app`/`components`).
Holds the frozen cross-module contracts, the error/money/config/constant kernel, pure utility helpers,
and — under `lib/db` — the **sole Prisma data-access layer**.
`lib` never imports `banking-sdk`, `agent`, `planner`, `security`, `audit`, `app`, or `components`.

## API Surface

- `request-constraints.ts` validates exact product comparisons, ordered steps and explicit success prerequisites before plan creation. `request-purchases.ts` binds each purchase to its own product/cent amount and rejects extra/missing plan nodes; it is pure and never changes permissions. Ambiguous conditions fail before writes. Resource aliases use repositories and never model-written node labels.

- `errors.ts` — `ErrorCode`, `AppError` (+ `AppError.from`), `Result<T>`, `ok()` / `err()`.
  Project-wide convention: return `Result<T>` or throw `AppError` at tool/SDK boundaries.
- `money.ts` — CNY helpers: `CNY` (`'¥'`), `round2`, `formatCNY` (`¥1,234.56`, negatives `-¥...`),
  `parseAmount` (strips `¥`/`,`/spaces; `0` for empty, `NaN` for non-numeric non-empty strings),
  `addMoney` / `subtractMoney` (cent math). All business logic must use these — never raw float math.
  `moneyToCents` validates safe integer cents without rounding fractional cents (IEEE-754 noise only
  is tolerated); `normalizeTransferAmount` additionally requires a positive amount and returns canonical CNY.
- `constants.ts` — `DAILY_TRANSFER_LIMIT = 1000`, `MFA_CODE = '123456'`, `MFA_MAX_ATTEMPTS = 3`,
  `ANOMALY_AMOUNT_THRESHOLD = 5000`, `DEFAULT_DEMO_USER_ID = 'user_liming'`,
  `SESSION_COOKIE = 'banking_session'`, `RISK_LABEL`, `DEMO_NOW` (pinned 2026-09-25 12:00 local).
- `config.ts` — `AppConfig` + `getConfig()`; reads env **at call time**
  (`LLM_MODE`/`LLM_PROVIDER`/`LLM_MODEL`/`DEMO_USER_ID`), so tests can toggle `LLM_MODE`.
- `ids.ts` — `newId(prefix?)`: unique id string (`node:crypto` `randomUUID`), optional readable prefix
  (`newId('pax')` → `pax_<uuid>`; no prefix → bare uuid).
- `date.ts` — pure, injectable-`now` LOCAL-timezone date helpers: `startOfDay(t)`, `todayRange(now?)`,
  `monthRange(now?)`, `previousMonthRange(now?)` (each returns half-open `{ start, end }` `[start, end)`),
  `formatDateTime(ts)` → zero-padded `YYYY-MM-DD HH:mm` (accepts `Date | number`, local time).
- `clock.ts` — the single source of "now" for the running app (the DEMO CLOCK, see root ROOT DECISION):
  `demoNow(override?: number | Date)` → `DEMO_NOW` unless overridden (a `Date` override → its `.getTime()`);
  convenience wrappers defaulting to the demo clock — `demoTodayRange(override?)`, `demoMonthRange(override?)`,
  `demoPreviousMonthRange(override?)` — each delegates to the matching `date.ts` helper via
  `new Date(demoNow(override))`.
  It also exports `realNow(): number` — the server's REAL wall clock (`Date.now()`), used ONLY for
  SECURITY elapsed-time gates (circuit-breaker lock timestamp / unlock cooldown, `now >= lockedAt + RESET_COOLDOWN_MS`);
  never use it for business dates, and never use `demoNow()` for security cooldown timing.
- `json.ts` — SQLite JSON-text column helpers: `safeParse<T>(text, fallback)` (returns `fallback` for
  null/undefined/empty/invalid JSON) and `toJson(value)` (`'null'` when value is `undefined`).
- `phone.ts` — mask-aware phone matching & masking (pure, never throws): `maskAwarePhoneMatch(value, stored)` → TRUE iff a RAW value matches a MASKED stored phone (exact, digit-substring either direction, or an anchored wildcard pattern from the stored phone's `*`-split fragments); `maskPhone(phone)` → first-3 + `****` + last-4. Lets a RAW phone lookup match the demo's MASKED-stored `Contact.phone` values.
- `ledger.ts` — deterministic idempotency keys + the canonical action→ledger-row IDENTITY.
  - `idempotentTransferTxId(userId, idempotencyKey)` → the canonical transfer-ledger id,
    `txidem_` + the first 32 hex chars of `sha256("<userId>\u0000<idempotencyKey>")`.
    The single source of truth that LINKS an idempotency key to the ledger `Transaction` row it produces:
    the Banking SDK derives that row's primary key from it, so supplying an idempotency key makes a repeat transfer at-most-once — it replays the original row instead of double-debiting.
  - `nodeExecutionKey(taskId, nodeId)` → the stable per-(`taskId`, `nodeId`) idempotency key for a plan node's SIDE EFFECT (format `nxe:<taskId>:<nodeId>`).
    Two runs of the same (task, node) dedupe to the same key, while a different plan (`taskId`) never collides.
  - `ledgerKeyForAction(action)` → the canonical de-dup IDENTITY of a `PendingAction`: `nodeExecutionKey(taskId, nodeId)` when the action is plan-linked (`taskId` AND `nodeId` both non-null/non-empty after trim), else the action's own `id`.
  - `ledgerTxIdForAction(userId, action)` → `idempotentTransferTxId(userId, ledgerKeyForAction(action))`, the ledger-row id `security/risk-engine` must look up to EXCLUDE an already-ledgered in-flight action from the cumulative daily-transfer total.
    Callers must use THIS (never `idempotentTransferTxId(userId, action.id)`) so a plan node's lookup MATCHES the id its row was generated with — otherwise the action is not recognized and is double-counted.
  - `executionReceiptId(userId, key)` → the deterministic id of the unified EXECUTION RECEIPT for one gated side effect,
    `rcpt_` + the first 32 hex chars of `sha256("<userId>\u0000<key>")`. A receipt is the durable COMMITTED-FACT record of
    an execution identity (`userId` + `key` — the SAME key `ledgerKeyForAction`/`idempotentTransferTxId` use), so a replay
    can recognize an already-committed side effect from PERSISTED data instead of re-resolving MUTABLE inputs.
  - `requestDigest(parts)` → the canonical fingerprint of a gated tool REQUEST: the lowercase-hex `sha256` of
    CANONICAL JSON of `parts` (object keys sorted recursively, `undefined` normalized to `null`; arrays keep their order).
    Key insertion order never changes the digest and an absent field hashes the same as an explicit `null`, so
    re-serializing an identical request always yields an identical digest. Used to decide whether a replay under the
    SAME execution identity is the same request (replay the stored result) or a different one (reject `CONFLICT`).
- `prisma-cli-env.ts` — shared Prisma-CLI **env policy + binary resolution**, the one piece every entry point that spawns the Prisma CLI imports (uses Node built-ins only — `node:fs`/`node:path` — no `@/` alias, no side effects at import).
  - `SCHEMA_ENGINE_RUST_LOG = 'info'` plus the two pinning helpers: `pinSchemaEngineLogging(env = process.env)` MUTATES and returns `env`; `prismaCliEnv(env?)` returns a NEW object and never mutates its input.
    Both force `RUST_LOG='info'` and default `RUST_BACKTRACE='1'`,
    because Prisma's schema-engine error mapper parses the engine's stderr as `split(/\r?\n/).slice(1)`:
    an ambient `RUST_LOG` at/above `warn` suppresses the engine's line-0 INFO banner, the real diagnostic (e.g. the `P1003 Database … does not exist` probe that `db push` relies on before creating a fresh SQLite file) lands at index 0 and is discarded, and the CLI fails with an opaque empty `Error: Schema engine error:`.
  - `CliInvocation` (`{ command, args }`), `resolveRepoRoot(startDir = process.cwd())` (walks up to the dir holding `package.json` + `next.config.mjs`), `resolvePrismaBin(repoRoot)` (`node_modules/prisma/build/index.js`, else `undefined`), `resolveTsxBin(repoRoot)` (`node_modules/tsx/dist/cli.mjs`, else `undefined`), `cliCommand(localBin, npxArgs)` (prefers the project-local bin launched with `process.execPath`; falls back to `cmd.exe /d /s /c "npx …"` on Windows / the plain command on POSIX).
- `contracts/` — the FROZEN cross-module type definitions (see routing table below).
  `contracts/security.ts` owns `PendingActionStatus`, the authoritative lifecycle enum of a gated action:
  its terminal member `needs_reconciliation` marks an action whose outcome is UNKNOWN (a gated write whose
  SDK side effect may have committed while its result/status transaction rolled back), so it must not
  dangle as a live decision and is surfaced to the user for manual reconciliation instead.
- `db/` — Prisma client singleton + per-aggregate repositories (the only data-access layer).
- `index.ts` — convenience barrel re-exporting `contracts`, `errors`, `money`, `config`, `constants`,
  `ids`, `date`, `clock`, `json` for `@/lib` imports. It deliberately does **NOT** re-export `db/`.

## Constraints

- `contracts/**` is frozen: child nodes IMPORT these types, they must NOT redeclare or fork them.
  Adding a new shared type means adding it here (root-owned).
- `db/repositories/**` is the **only** code that imports `prisma`/`@prisma/client`; every other module
  persists exclusively through these repositories.
- Repository reads return Prisma model rows; **JSON-text columns stay `string | null`** and are parsed
  by callers with `lib/json` (`safeParse`). Repository writes that take structured payloads serialize
  with `toJson`.
- Money is `Float` CNY; use `lib/money` helpers, never raw float math.
- Date helpers must be pure and take an injectable `now` — no hidden `Date.now()` inside range helpers.
- Any "now" in the running app goes through `lib/clock` (`demoNow()`), never raw `Date.now()`.
- `index.ts` must not import `lib/db` (keeps the Prisma client out of client-side bundles).
- Pure TypeScript; no side effects at module load, no network. Sole exception: `db/client.ts`
  constructs the Prisma singleton. `ledger.ts` stays pure (only `node:crypto`).
- Files use relative imports between each other — no path aliases assumed.
- Keep files ≲ ~1000 lines; split by responsibility.

## Routing Table

- `./lib/contracts` → frozen cross-module types — `risk.ts` (RiskLevel/PermissionTier/TransferPolicy),
  `tools.ts` (ToolName/ToolCategory/ToolDescriptor), `security.ts` (SecurityEvaluation/SecurityDecision/
  PendingAction/PendingActionSummary/PendingActionStatus — whose TERMINAL member `needs_reconciliation`
  marks a gated write whose outcome is UNKNOWN (the SDK side effect may have committed while the
  result/status transaction rolled back): it is neither `failed` nor a live decision to confirm, it is
  queryable and surfaced to the user as a manual-reconciliation entry),
  `audit.ts` (AuditEntry/AuditStatus/SecurityEvent/SecurityEventKind),
  `task.ts` (TaskPlan/TaskNodeSpec/TaskNodeResult/TaskCondition), `agent.ts` (ChatMessage/ChatCard/
  AgentStreamEvent/ChatTurnRequest/Response), `index.ts` (barrel re-export).
- `./lib/db` → Prisma client singleton (`client.ts`) + typed per-aggregate repositories (`repositories/`),
  incl. the atomic exactly-once `claimPendingAction` / ownership-aware `getPendingActionOwnership` primitives
  and the optional-`client` transaction-composable `pendingAction` & `executionReceipt` repositories
  (a caller can write a receipt in the SAME `prisma.$transaction` as the side effect it records).
- `./lib/errors.ts` → `ErrorCode` / `AppError` / `Result<T>` — the project error convention.
- `./lib/money.ts` → CNY formatting/parsing/cent-safe arithmetic.
- `./lib/constants.ts` → demo constants (limits, MFA code, thresholds, demo user id, cookie name, `DEMO_NOW`).
- `./lib/config.ts` → `getConfig()` runtime env config.
- `./lib/ids.ts` → `newId(prefix?)` id generation.
- `./lib/date.ts` → pure local-timezone date-range/format helpers.
- `./lib/clock.ts` → demo clock: `demoNow()` + demo range wrappers, plus `realNow()` (the server REAL wall clock `Date.now()`) used ONLY for SECURITY elapsed-time gates (breaker lock timestamp / unlock cooldown) — never for business dates.
- `./lib/json.ts` → JSON-text column (de)serialization for SQLite.
- `./lib/ledger.ts` → deterministic idempotency keys + canonical action→ledger-row identity — `idempotentTransferTxId`, `nodeExecutionKey`, `ledgerKeyForAction`, `ledgerTxIdForAction`, plus the EXECUTION-RECEIPT helpers `executionReceiptId` / `requestDigest`.
- `./lib/phone.ts` → mask-aware phone matching & masking — `maskAwarePhoneMatch(value, stored)` (raw↔masked) and `maskPhone(phone)`; the shared helper that lets a RAW phone lookup match the demo's MASKED-stored `Contact.phone` values (used by the `security/recipient-resolution.ts` write path AND the `lib/db/repositories/contact.ts#searchContacts` read path).
- `./lib/prisma-cli-env.ts` → Prisma-CLI env pinning + bin resolution — `SCHEMA_ENGINE_RUST_LOG`, `pinSchemaEngineLogging`, `prismaCliEnv`, `CliInvocation`, `resolveRepoRoot`, `resolvePrismaBin`, `resolveTsxBin`, `cliCommand`; re-exported by `tests/helpers/prisma-cli.ts` (its public API is unchanged) and consumed by `scripts/db-push.ts` (the `npm run db:push` / `db:reset` deploy entry).
- `./lib/index.ts` → convenience barrel for `@/lib` imports (no `db`).

## Status

- Fully implemented: every `lib/*.ts` util helper (`errors`, `money`, `config`, `constants`, `ids`,
  `date`, `clock`, `json`, `ledger`, `prisma-cli-env`), `db/client.ts`, and all `lib/db/repositories/*` aggregate modules.

## Notes for Agents

- If you need a value that every layer shares (limit, threshold, code), add it to `constants.ts`, not locally.
- Prisma-CLI environment policy lives ONLY in `lib/prisma-cli-env.ts`
  (`tests/setup.ts` and the E2E harness reach it via `tests/helpers/prisma-cli.ts`; the deploy path via `scripts/db-push.ts`).
  Import it instead of re-implementing the `RUST_LOG=info` pin or the local-binary resolution at a call site, so a cold-checkout `db push` keeps provisioning a fresh SQLite file.
- The DB target is chosen **only** by `process.env.DATABASE_URL` (read at module load by
  `lib/db/client.ts` → `resolveDatabaseUrl()`), with a cwd-based `prisma/dev.db` fallback — there is **no
  dotenv in `lib`** (implicit `.env` loading comes from Next.js's dev/build env loader or the Prisma CLI).
  Setting an absolute `file:` `DATABASE_URL` in a child process's env is the supported way to redirect both
  the Prisma CLI and the runtime client to an isolated SQLite file. See `lib/db/CONTEXT.md`.
- Never import `prisma` outside `lib/db/repositories/**` — go through a repository.
- When adding a repository aggregate, keep one module per aggregate and register it in
  `lib/db/repositories/index.ts`.
- The `AgentTaskNode.pendingActionId` DAG-resume column is missing from the frozen schema — see
  `lib/db/repositories/CONTEXT.md` `## Known Issues`; the plan↔operation link is instead persisted on `PendingAction.taskId`/`nodeId` and read back via `getPendingActionPlanLink`/`listPendingActionsByTask`.
