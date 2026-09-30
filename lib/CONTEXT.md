# lib — Shared Kernel (frozen contracts)

## Intent

The lowest layer of the dependency graph (`lib` ← `banking-sdk` ← `agent`/`planner`/`audit` ← `app`/`components`).
Everything here is imported by the modules above it and must stay free of upward dependencies.
`lib` never imports `banking-sdk`, `agent`, `planner`, `security`, `audit`, or `prisma` (only the Prisma
client living under `lib/db`).

## API Surface

- `errors.ts` — `ErrorCode`, `AppError` (+ `AppError.from`), `Result<T>`, `ok()` / `err()` helpers.
  The project-wide error convention: return `Result<T>` or throw `AppError` at tool/SDK boundaries.
- `money.ts` — CNY helpers: `CNY` (`'¥'`), `round2`, `formatCNY` (`¥1,234.56`, negatives `-¥...`),
  `parseAmount` (strips `¥`/`,`/spaces; `0` for empty, `NaN` for non-numeric non-empty strings),
  `addMoney` / `subtractMoney` (cent math). All business logic must use these — never raw float math.
- `constants.ts` — `DAILY_TRANSFER_LIMIT = 1000`, `MFA_CODE = '123456'`, `MFA_MAX_ATTEMPTS = 3`,
  `ANOMALY_AMOUNT_THRESHOLD = 5000`, `DEFAULT_DEMO_USER_ID = 'user_liming'`,
  `SESSION_COOKIE = 'banking_session'`, `RISK_LABEL`.
- `config.ts` — `AppConfig` + `getConfig()`; reads env **at call time**
  (`LLM_MODE`/`LLM_PROVIDER`/`LLM_MODEL`/`DEMO_USER_ID`), so tests can toggle `LLM_MODE`.
- `contracts/` — the FROZEN cross-module type definitions (see routing table below).

## Constraints

- `contracts/**` is frozen: child nodes IMPORT these types, they must NOT redeclare or fork them.
  Adding a new shared type means adding it here (root-owned).
- `contracts/` re-exports everything from `contracts/index.ts`; other modules import from
  `lib/contracts` (barrel) or from the specific file, never via deep relative `../../` paths.
- Files use relative imports between each other (`./risk`, `./contracts/risk`) — no path aliases assumed.
- Pure TypeScript, no side effects at module load, no network/DB access.
- Keep files ≲ ~1000 lines; split by responsibility.

## Routing Table

- `./lib/contracts` → `risk.ts` (RiskLevel/PermissionTier/TransferPolicy), `tools.ts` (ToolName/ToolCategory/ToolDescriptor),
  `security.ts` (SecurityEvaluation/SecurityDecision/PendingAction), `audit.ts` (AuditEntry/AuditStatus/SecurityEvent),
  `task.ts` (TaskPlan/TaskNodeSpec/TaskNodeResult), `agent.ts` (ChatMessage/ChatCard/AgentStreamEvent/ChatTurnRequest/Response),
  `index.ts` (barrel re-export)
- `./lib/db` → Prisma client singleton + typed repositories (owned separately from the contracts above)
