# lib — Shared Kernel

## Intent

The lowest layer of the dependency graph (`lib` ← `banking-sdk` ← `agent`/`planner`/`audit` ← `app`/`components`).
Holds the frozen cross-module contracts, the error/money/config/constant kernel, pure utility helpers,
and — under `lib/db` — the **sole Prisma data-access layer**.
`lib` never imports `banking-sdk`, `agent`, `planner`, `security`, `audit`, `app`, or `components`.

## API Surface

- `errors.ts` — `ErrorCode`, `AppError` (+ `AppError.from`), `Result<T>`, `ok()` / `err()`.
  Project-wide convention: return `Result<T>` or throw `AppError` at tool/SDK boundaries.
- `money.ts` — CNY helpers: `CNY` (`'¥'`), `round2`, `formatCNY` (`¥1,234.56`, negatives `-¥...`),
  `parseAmount` (strips `¥`/`,`/spaces; `0` for empty, `NaN` for non-numeric non-empty strings),
  `addMoney` / `subtractMoney` (cent math). All business logic must use these — never raw float math.
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
- `json.ts` — SQLite JSON-text column helpers: `safeParse<T>(text, fallback)` (returns `fallback` for
  null/undefined/empty/invalid JSON) and `toJson(value)` (`'null'` when value is `undefined`).
- `ledger.ts` — deterministic idempotency keys: `idempotentTransferTxId(userId, idempotencyKey)` is the canonical transfer-ledger id,
  `txidem_` + the first 32 hex chars of `sha256("<userId>\u0000<idempotencyKey>")`.
  It is the single source of truth that LINKS a gated transfer `PendingAction` to the ledger `Transaction` row it produces:
  the Banking SDK derives that row's primary key from it (supplying an idempotency key makes a repeat transfer at-most-once — a repeat replays the original row instead of double-debiting), and `security/` uses it to EXCLUDE already-ledgered in-flight actions from the cumulative daily-transfer total.
  `nodeExecutionKey(taskId, nodeId)` is the stable per-(`taskId`, `nodeId`) idempotency key for a plan node's SIDE EFFECT (format `nxe:<taskId>:<nodeId>`).
  Two runs of the same (task, node) dedupe to the same key, while a different plan (`taskId`) never collides.
- `contracts/` — the FROZEN cross-module type definitions (see routing table below).
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
  constructs the Prisma singleton.
- Files use relative imports between each other — no path aliases assumed.
- Keep files ≲ ~1000 lines; split by responsibility.

## Routing Table

- `./lib/contracts` → frozen cross-module types — `risk.ts` (RiskLevel/PermissionTier/TransferPolicy),
  `tools.ts` (ToolName/ToolCategory/ToolDescriptor), `security.ts` (SecurityEvaluation/SecurityDecision/
  PendingAction/PendingActionSummary), `audit.ts` (AuditEntry/AuditStatus/SecurityEvent/SecurityEventKind),
  `task.ts` (TaskPlan/TaskNodeSpec/TaskNodeResult/TaskCondition), `agent.ts` (ChatMessage/ChatCard/
  AgentStreamEvent/ChatTurnRequest/Response), `index.ts` (barrel re-export).
- `./lib/db` → Prisma client singleton (`client.ts`) + typed per-aggregate repositories (`repositories/`),
  incl. the atomic exactly-once `claimPendingAction` / ownership-aware `getPendingActionOwnership` primitives.
- `./lib/errors.ts` → `ErrorCode` / `AppError` / `Result<T>` — the project error convention.
- `./lib/money.ts` → CNY formatting/parsing/cent-safe arithmetic.
- `./lib/constants.ts` → demo constants (limits, MFA code, thresholds, demo user id, cookie name, `DEMO_NOW`).
- `./lib/config.ts` → `getConfig()` runtime env config.
- `./lib/ids.ts` → `newId(prefix?)` id generation.
- `./lib/date.ts` → pure local-timezone date-range/format helpers.
- `./lib/clock.ts` → demo clock: `demoNow()` + demo range wrappers.
- `./lib/json.ts` → JSON-text column (de)serialization for SQLite.
- `./lib/ledger.ts` → deterministic idempotency keys — transfer-ledger id (`idempotentTransferTxId`) and per-(plan,node) node side-effect key (`nodeExecutionKey`).
- `./lib/index.ts` → convenience barrel for `@/lib` imports (no `db`).

## Status

- Fully implemented: every `lib/*.ts` util helper (`errors`, `money`, `config`, `constants`, `ids`,
  `date`, `clock`, `json`, `ledger`), `db/client.ts`, and all `lib/db/repositories/*` aggregate modules.

## Notes for Agents

- If you need a value that every layer shares (limit, threshold, code), add it to `constants.ts`, not locally.
- The DB target is chosen **only** by `process.env.DATABASE_URL` (read at module load by
  `lib/db/client.ts` → `resolveDatabaseUrl()`), with a cwd-based `prisma/dev.db` fallback — there is **no
  dotenv in `lib`** (implicit `.env` loading comes from Next.js's dev/build env loader or the Prisma CLI).
  Setting an absolute `file:` `DATABASE_URL` in a child process's env is the supported way to redirect both
  the Prisma CLI and the runtime client to an isolated SQLite file. See `lib/db/CONTEXT.md`.
- Never import `prisma` outside `lib/db/repositories/**` — go through a repository.
- When adding a repository aggregate, keep one module per aggregate and register it in
  `lib/db/repositories/index.ts`.
- The `AgentTaskNode.pendingActionId` DAG-resume column is missing from the frozen schema — see
  `lib/db/repositories/CONTEXT.md` `## Known Issues` for the exact `prisma/schema.prisma` addition needed.
