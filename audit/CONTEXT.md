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
  - `recordAudit(entry: AuditEntry, opts?: RecordAuditOptions): Promise<AuditEntry>` — append one audit entry; JSON-serializes `toolResult`/`detail`. Best-effort by default (never rejects); with `opts.strict === true` a real persistence failure REJECTS so the caller's `prisma.$transaction` rolls back (only a verified same-`dedupeKey` duplicate is absorbed as an idempotent no-op).
  - `listAudit(filter: AuditFilter): Promise<AuditEntry[]>` — query newest-first by optional filter.
  - `getAuditSummary(): Promise<AuditSummary>` — `{ total, byRisk, byStatus }` counts for the dashboard.
  - types: `AuditFilter` (`{ sessionId?, toolName?, riskLevel?, status?, limit? }`), `AuditSummary`, `RecordAuditOptions` (`{ client?: Prisma.TransactionClient; dedupeKey?: string; strict?: boolean }`).
  - `auditStore` — repository bindings seam (testability; see Dependencies).
- `audit/security-events.ts`
  - `recordSecurityEvent(event: Omit<SecurityEvent,'id'|'timestamp'> & { timestamp? }): Promise<SecurityEvent>` — append one event; `timestamp` defaults to `demoNow()` (the demo clock).
  - `listSecurityEvents(filter?: SecurityEventFilter): Promise<SecurityEvent[]>` — query newest-first.
  - `getSecurityStatus(sessionId, options?): Promise<SecurityStatus>` — `{ locked, recentEvents }`.
  - types: `SecurityEventFilter` (`{ sessionId?, kind?, limit? }`), `SecurityStatus`, `SecurityStatusOptions` (`{ isLocked?, recentLimit?, filter? }`), `BreakerLookup`.
  - `securityEventStore` — repository bindings seam (testability; see Dependencies).

## Constraints

- Execution and manual-review events are DISTINCT: agent convergence uses `exec:<actionId>` for
  execution and `reconcile:<actionId>` for manual review. Never overwrite a committed success audit
  or absorb a contradictory outcome as the same event. The manual-review audit and action state
  land in one strict transaction; a failed audit leaves the prior state available for retry.

- **Transaction composition**: `recordAudit(entry, { client, dedupeKey, strict })` accepts a `Prisma.TransactionClient` (`client`) so an audit write CAN be folded into the caller's `prisma.$transaction`, and an optional unique `dedupeKey` makes a repeat write of the SAME execution identity idempotent. `recordSecurityEvent` accepts NO `client`/`tx` and always writes via the global `prisma` singleton (`@/lib/db/client`), so a security-event write is NOT transaction-composable.
- **Dependency direction**: `lib` ← `audit`. This node imports ONLY `lib/contracts/*`,
  `lib/db/repositories/*`, `lib/db/client`, `lib/errors`, and `lib/clock`. It **MUST NOT** import
  `security`, `agent`, `planner`, or `banking-sdk` — the Security Gateway depends on `audit` for
  logging, so any reverse import creates a dependency cycle. (The P2002 unique-violation check in
  `recordAudit` is therefore INLINED rather than imported from `banking-sdk`.)
- **Never redeclare frozen types**: `AuditEntry`, `AuditStatus`, `SecurityEvent`,
  `SecurityEventKind` come from `@/lib/contracts/audit` — import, never fork.
- **Error strategy — best-effort by default, strict on request**: `recordAudit` / `recordSecurityEvent` are best-effort by DEFAULT and never throw into the request path — on persistence failure they `console.error` and resolve with the input entry/event. A caller may opt into `recordAudit(..., { strict: true })`, in which case a real persistence failure REJECTS (the original error is propagated unchanged) so the caller's enclosing `prisma.$transaction` rolls back its business writes; the ONLY failure strict mode absorbs is a VERIFIED duplicate of the SAME `dedupeKey` — a Prisma unique-constraint violation (P2002) AND a row with that exact key already present on the same client (`findUnique` back-read) — treated as an idempotent no-op. A missing `dedupeKey`, an absent back-read row, or a throwing back-read all rethrow the ORIGINAL insert error. Reads/query functions delegate to the store seam and wrap any non-`AppError` via `AppError.from(e)` (code `INTERNAL`) and rethrow — never silently swallowed.
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
- `@/lib/db/client` (`prisma` — the global singleton used as the default `client` for the strict-mode `dedupeKey` back-read).
- `@/lib/db/repositories/auditLog` (owned by `./lib`) — surface used:
  `insertAuditLog(entry: AuditEntry, opts?: { client?; dedupeKey? }): Promise<AuditEntry>`,
  `findAuditLogs(filter: { sessionId?; toolName?; riskLevel?; status?; limit? }): Promise<AuditEntry[]>`,
  `aggregateAuditLogs(): Promise<{ total; byRisk; byStatus }>`. JSON-serializes `toolResult`; `dedupeKey` maps to the unique `AuditLog.dedupeKey` column.
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
- Strict mode is exercised by stubbing `auditStore.insertAuditLog` to throw: `strict: true` rethrows
  the ORIGINAL error, EXCEPT a P2002 unique violation whose `dedupeKey` row is found by the
  back-read on the same client AND matches the session/tool/risk/decision/business result identity
  (idempotent no-op). Transfer results compare the original transaction id, amount and counterparty;
  narration and unavailable legacy balance/phone fields do not change business identity. A conflicting
  duplicate, a `dedupeKey`-less failure or a non-P2002 failure rejects.
- `getSecurityStatus` is tested with an injected `isLocked` callback (authoritative) and without
  it (event-derived fallback).
- Scenario coverage lives in the `../tests/` integration suite (faux provider) — audit assertions
  verify the required fields landed for each gated execution and blocked/confirmed decision; the
  `../tests/integration/committed-outcomes.test.ts` review spec drives the transactional settle path
  that opts into `strict`.
- No network and no live Prisma required for unit tests; use the test SQLite DB for reads.

## Known Issues

- **Audit idempotency is opt-in via `dedupeKey`; no outbox/retry**: `insertAuditLog` writes an optional unique `dedupeKey` (`AuditLog.dedupeKey @unique`) so a repeat write of the SAME execution identity is a P2002 duplicate; without a `dedupeKey` it always `create`s a NEW row. `insertSecurityEvent` has NO unique key / dedup at all. No outbox/retry mechanism exists — a swallowed best-effort write failure is never retried (a transactional caller opts into `strict` to force a rollback instead).
- On the cancel path `toolResult` and `mfaResult` are intentionally omitted (nothing executed / no MFA) and persisted null (see `cancelAction` in `../agent/confirmation.ts`).
- `SecurityEventKind` values `HIGH_RISK_BLOCKED` and `ANOMALY_FLAGGED` have NO producer anywhere: the gateway's locked-session `deny` uses `HIGH_RISK_BLOCKED` only as an opaque block-reason TAG (it writes no `SecurityEvent`), and `detect_anomaly` (`banking-sdk/transaction.ts`) is READ-ONLY.
- The other `SecurityEventKind`s ARE produced: `CIRCUIT_BREAKER_TRIPPED` and `SECURITY_RESET` (`../security/circuit-breaker.ts` `recordFailure`/`resetSession`), `LIMIT_EXCEEDED` (`../security/security-gateway.ts` transfer escalation at execution time), `MFA_FAILURE` (`../security/mfa.ts` `verify`), `INJECTION_ATTEMPT` (`../security/injection-guard.ts` `reportInjection`, called by `../agent/run-turn.ts`).
- No dedicated unit tests for this node (`../tests/unit/` has `security/`, `planner/`, `banking-sdk/`, `agent/`, `lib/` but no `audit/`); coverage is indirect — the scenario suite (test-02/03/04/10) asserts toolName/riskLevel/status/confirmationRequired/confirmed/mfaRequired/mfaResult, `../tests/unit/agent/confirmation.test.ts` asserts the `userRequest`/`intent`/`timestamp === demoNow()` fields the confirm/verify/cancel paths write, and `../tests/integration/committed-outcomes.test.ts` covers the `strict` transactional settle path.

## Notes for Agents

- Do not add business/risk logic to this node — logging and querying only.
