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

- **Dependency direction**: `lib` ← `audit`. This node imports ONLY `lib/contracts/*` and
  `lib/db/repositories/*`. It **MUST NOT** import `security`, `agent`, `planner`, `banking-sdk`,
  or `prisma` directly — the Security Gateway depends on `audit` for logging, so any reverse
  import creates a dependency cycle.
- **Never redeclare frozen types**: `AuditEntry`, `AuditStatus`, `SecurityEvent`,
  `SecurityEventKind` come from `@/lib/contracts/audit` — import, never fork.
- **Error strategy — writes never throw into the request path**: `recordAudit` and
  `recordSecurityEvent` are best-effort. On persistence failure they log and resolve with the
  input entry/event (they do NOT reject), so a failed audit write never breaks a banking flow.
  Read/query functions MAY propagate `AppError` (`INTERNAL`) at this boundary.
- **Audit entries must be complete**: every `recordAudit` call carries the required fields —
  `timestamp, sessionId, userRequest, intent, toolName, riskLevel, confirmationRequired,
  confirmed, mfaRequired, mfaResult, toolResult, status` (see `AuditEntry` in lib/contracts).
- **Circuit-breaker authority stays in `security`**: `getSecurityStatus` prefers an injected
  `isLocked` callback (the security node's breaker) and only falls back to deriving lock state
  from the persisted event stream. Do not re-implement breaker logic here.
- Import via the `@/*` path alias (`@/lib/...`) — matches the project's `tsconfig`/`vitest` alias.
- Keep files ≲ ~1000 lines; split by responsibility.

## Dependencies

- `@/lib/contracts/audit` (frozen types), `@/lib/contracts/risk` (`RiskLevel`).
- `@/lib/db/repositories/auditLog` (owned by `./lib`) — expected surface:
  `insertAuditLog(entry: AuditEntry): Promise<AuditEntry>`,
  `findAuditLogs(filter: { sessionId?; toolName?; riskLevel?; status?; limit? }): Promise<AuditEntry[]>`,
  `aggregateAuditLogs(): Promise<{ total: number; byRisk: Record<string, number>; byStatus: Record<string, number> }>`.
- `@/lib/db/repositories/securityEvent` (owned by `./lib`) — expected surface:
  `insertSecurityEvent(event: SecurityEvent): Promise<SecurityEvent>`,
  `findSecurityEvents(filter: { sessionId?; kind?; limit? }): Promise<SecurityEvent[]>`.
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

## Notes for Agents

- The functions are intentionally stubbed (`throw new Error('not implemented')`) — this is a
  design-only skeleton. Implementation fills the bodies; signatures and types are frozen here.
- Do not add business/risk logic to this node — logging and querying only.
