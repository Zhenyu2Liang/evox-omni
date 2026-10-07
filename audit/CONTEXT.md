# audit — Audit Log & Security Events

## Intent

The **single persistence + query API** for the agent's accountability trail: every tool-call
audit entry (`AuditEntry`) and every security event (`SecurityEvent`). It backs the 审计 (audit)
step of the agent loop 理解 → 规划 → 执行 → 风控 → 验证 → 审计 and feeds the audit dashboard and
security-center read models.

This node is a **thin wrapper over Prisma-backed repositories** in `./lib/db/repositories`. It
holds no business rules of its own — the Security Gateway decides *what* to log, this node
decides *how it is stored and queried*.

## API Surface

Public entry point is the facade `./index.ts` (`export const audit = { ... }`), which also
re-exports each function and its types.

- `audit/audit-logger.ts`
  - `recordAudit(entry: AuditEntry): Promise<AuditEntry>` — append one audit entry; JSON-serializes `toolResult`/`detail`.
  - `listAudit(filter: AuditFilter): Promise<AuditEntry[]>` — query newest-first by optional filter.
  - `getAuditSummary(): Promise<AuditSummary>` — `{ total, byRisk, byStatus }` counts for the dashboard.
  - types: `AuditFilter` (`{ sessionId?, toolName?, riskLevel?, status?, limit? }`), `AuditSummary`.
  - `auditStore` — repository bindings seam (testability; see Dependencies).
- `audit/security-events.ts`
  - `recordSecurityEvent(event: Omit<SecurityEvent,'id'|'timestamp'> & { timestamp? }): Promise<SecurityEvent>` — append one event; `timestamp` defaults to `demoNow()` (the demo clock).
  - `listSecurityEvents(filter?: SecurityEventFilter): Promise<SecurityEvent[]>` — query newest-first.
  - `getSecurityStatus(sessionId, options?): Promise<SecurityStatus>` — `{ locked, recentEvents }`.
  - types: `SecurityEventFilter` (`{ sessionId?, kind?, limit? }`), `SecurityStatus`, `SecurityStatusOptions` (`{ isLocked?, recentLimit?, filter? }`), `BreakerLookup`.
  - `securityEventStore` — repository bindings seam (testability; see Dependencies).

## Constraints

- **Writes are NOT transaction-composable**: `recordAudit` / `recordSecurityEvent` accept NO `Prisma.TransactionClient` — they go through the store seam to `insertAuditLog` / `insertSecurityEvent`, which use the **global `prisma` singleton** (`@/lib/db/client`). An audit/security-event write therefore CANNOT be folded into a caller's `prisma.$transaction` (unlike `@/lib/db/repositories/pendingAction` functions, which take `client: Prisma.TransactionClient = prisma`). To make an audit write atomic with a business fact today would require adding a `client`/`tx` parameter to this node's write functions and to the repository functions they delegate to.
- **Dependency direction**: `lib` ← `audit`. This node imports ONLY `lib/contracts/*`,
  `lib/db/repositories/*`, `lib/errors`, and `lib/clock`. It **MUST NOT** import `security`,
  `agent`, `planner`, `banking-sdk`, or `prisma` directly — the Security Gateway depends on
  `audit` for logging, so any reverse import creates a dependency cycle.
- **Never redeclare frozen types**: `AuditEntry`, `AuditStatus`, `SecurityEvent`,
  `SecurityEventKind` come from `@/lib/contracts/audit` — import, never fork.
- **Error strategy — writes never throw into the request path**: `recordAudit` and
  `recordSecurityEvent` are best-effort. They `await` the write via the store seam; on
  persistence failure they `console.error` the failure and resolve with the input entry/event
  (they do NOT reject), so a failed audit write never breaks a banking flow. Reads/query
  functions delegate to the store seam and wrap any non-`AppError` via `AppError.from(e)`
  (code `INTERNAL`) and rethrow — never silently swallowed.
- **Audit entries must be complete**: every `recordAudit` call carries the required fields —
  `timestamp, sessionId, userRequest, intent, toolName, riskLevel, confirmationRequired,
  confirmed, mfaRequired, mfaResult, toolResult, status` (see `AuditEntry` in lib/contracts).
- **Circuit-breaker authority stays in `security`**: `getSecurityStatus` prefers an injected
  `isLocked` callback (the security node's breaker) and only falls back to deriving lock state
  from the persisted event stream (newest `CIRCUIT_BREAKER_TRIPPED`/`SECURITY_RESET` decides;
  scan window `LOCK_SCAN_LIMIT`). Do not re-implement breaker counters here.
- Import via the `@/*` path alias (`@/lib/...`) — matches the project's `tsconfig`/`vitest` alias.
- Keep files ≲ ~1000 lines; split by responsibility.

## Dependencies

- `@/lib/contracts/audit` (frozen types), `@/lib/contracts/risk` (`RiskLevel`).
- `@/lib/errors` (`AppError`), `@/lib/clock` (`demoNow` — write timestamps use the demo clock).
- `@/lib/db/repositories/auditLog` (owned by `./lib`) — surface used:
  `insertAuditLog(entry: AuditEntry): Promise<AuditEntry>`,
  `findAuditLogs(filter: { sessionId?; toolName?; riskLevel?; status?; limit? }): Promise<AuditEntry[]>`,
  `aggregateAuditLogs(): Promise<{ total; byRisk; byStatus }>`. JSON-serializes `toolResult`.
- `@/lib/db/repositories/securityEvent` (owned by `./lib`) — surface used:
  `insertSecurityEvent(event: SecurityEvent): Promise<SecurityEvent>`,
  `findSecurityEvents(filter: { sessionId?; kind?; limit? }): Promise<SecurityEvent[]>`. JSON-serializes `detail`.
- Repository params are structural (primitives / `lib/contracts` types) so `lib` never imports `audit`.
- `./security` (circuit-breaker lock state) is a **runtime** dependency injected via
  `SecurityStatusOptions.isLocked` — not a code import.

## Routing Table

- `./audit-logger.ts` → tool-call audit write + query + summary (`AuditEntry`)
- `./security-events.ts` → security-event write + query + per-session status (`SecurityEvent`)
- `./index.ts` → facade `audit` object + type re-exports (public entry point)
- `../lib/contracts/audit.ts` → frozen `AuditEntry`/`AuditStatus`/`SecurityEvent`/`SecurityEventKind` (sibling — read-only, escalate writes to root)
- `../lib/db/repositories/` → Prisma repositories this node delegates to (sibling — read-only, escalate writes to root)
- `../security/` → circuit-breaker lock state consumer/source (sibling — read-only, escalate writes to root)
- `../tests/` → security/audit unit tests + faux-LLM scenario integration tests (sibling — read-only, escalate writes to root)

## Test Strategy

- **Unit tests** (Vitest, no DB required): stub `auditStore` / `securityEventStore` (or the
  repositories) to assert filtering, newest-first ordering, summary aggregation, `timestamp`
  defaulting, and the never-throw-on-write contract (a throwing store still resolves).
- `getSecurityStatus` is tested with an injected `isLocked` callback (authoritative) and without
  it (event-derived fallback).
- Scenario coverage lives in the `../tests/` integration suite (faux provider) — audit assertions
  verify the required fields landed for each gated execution and blocked/confirmed decision.
- No network and no live Prisma required for unit tests; use the test SQLite DB for reads.

## Known Issues

- On the cancel path `toolResult` and `mfaResult` are intentionally omitted (nothing executed / no MFA) and persisted null (see `cancelAction` in `../agent/confirmation.ts`).
- `SecurityEventKind` values `HIGH_RISK_BLOCKED` and `ANOMALY_FLAGGED` have NO producer anywhere: the gateway's locked-session `deny` uses `HIGH_RISK_BLOCKED` only as an opaque block-reason TAG (it writes no `SecurityEvent`), and `detect_anomaly` (`banking-sdk/transaction.ts`) is READ-ONLY.
- The other `SecurityEventKind`s ARE produced: `CIRCUIT_BREAKER_TRIPPED` and `SECURITY_RESET` (`../security/circuit-breaker.ts` `recordFailure`/`resetSession`), `LIMIT_EXCEEDED` (`../security/security-gateway.ts` transfer escalation at execution time), `MFA_FAILURE` (`../security/mfa.ts` `verify`), `INJECTION_ATTEMPT` (`../security/injection-guard.ts` `reportInjection`, called by `../agent/run-turn.ts`).
- No dedicated unit tests for this node (`../tests/unit/` has `security/`, `planner/`, `banking-sdk/`, `agent/`, `lib/` but no `audit/`); coverage is indirect — the scenario suite (test-02/03/04/10) asserts toolName/riskLevel/status/confirmationRequired/confirmed/mfaRequired/mfaResult, and `../tests/unit/agent/confirmation.test.ts` asserts the `userRequest`/`intent`/`timestamp === demoNow()` fields the confirm/verify/cancel paths write.

## Notes for Agents

- Do not add business/risk logic to this node — logging and querying only.
