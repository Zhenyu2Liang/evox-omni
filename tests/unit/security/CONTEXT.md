# tests/unit/security — security-model unit specs

## Intent

Prove the **code-enforced, LLM-immutable** security model at the unit level: tiers come from a static
policy table + dynamic rules (never from the model), transfers escalate by amount/daily-total, the
gateway serializes/parses block reasons and gates on confirmation, injection scanning never grants
permission, and the circuit breaker locks a session after 3 consecutive MFA failures.

## API Surface

Fourteen spec files (grouped below by concern), each with **real assertions** (no `it.todo` remain),
targeting `@/security/<module>` via the `@/security` facade (`{gateway, permission, risk, mfa,
circuitBreaker, injection}`) or the module directly:

**Permission & risk**
- `permission-engine.test.ts` — `TOOL_POLICY` exhaustiveness vs the `ToolName` union, static GREEN/YELLOW/RED tiers, `getToolPolicy` (unknown → `AppError('VALIDATION')`), `evaluateTool` (GREEN no confirm/no mfa, YELLOW confirm, RED confirm+mfa; dynamic `transfer_money` delegated to the risk engine; `submit_plan` not risk-gated; LLM-immutability — whimsical/spoofed args & `ctx` never change the tier). Pure, no DB.
- `risk-engine.test.ts` — `evaluateTransferRisk` boundary at ¥1000 (`>` is strict) + `computeDailyTransferTotal` (test SQLite). Pure part has no DB.
- `risk-engine-rerisk.test.ts` — `reEvaluateTransferRisk(userId, amount, now?)` re-risks against a FRESH day total at EXECUTION time (closes the stale-parked-transfer bypass) + facade exposure + strict `>` boundary. DB-backed.

**Gateway**
- `gateway.test.ts` — `securityGateway.evaluate/decide/createPendingAction/serializeBlockReason/parseBlockReason/authorizeAction/cancelAction/handleToolCall` + `buildPendingActionSummary` + `BLOCK_REASON_PREFIX`. Persistence cases need test SQLite.
- `gateway-audit-trail.test.ts` — the `TOOL_INTENT` map + `deriveIntent` (pure, LLM-immutable label) and the persistence touch-points (`createPendingAction`/`handleToolCall` persist the ORIGINAL `userRequest` + derived `intent`; `toContractPendingAction` surfaces both). DB-backed.
- `authorize-hardening.test.ts` — `authorizeAction`/`cancelAction`/`recordActionResult` hardening: repeat confirm → `CONFLICT`, cancel/confirm after settle → `CONFLICT`, ownership mismatch → `SECURITY_DENIED`, execution-time re-risk of a YELLOW-parked transfer (against a RAW prior `Transaction` row), `recordActionResult` TRUE terminal status, locked session → `status:'locked'`. DB-backed, unique sessionId.
- `authorize-concurrency.test.ts` — gateway concurrency / execution-time re-risk driven through the REAL `@/agent` confirm/verify façade: (1) two SIMULTANEOUS confirms of ONE YELLOW action → EXACTLY ONE executes (atomic exactly-once claim), the loser a typed `ok:false`/`CONFLICT`, balance moves once, only the winner is audited, and a later SEQUENTIAL confirm is `ok:false`; (2) TWO queued YELLOW ¥600 transfers → after the FIRST executes the SECOND re-risks to RED at execution time and returns `awaiting_mfa` (no execution) yet stays completable via `verifyAction(code)`. DB-backed, unique persisted session.

**Transfer limits & concurrency**
- `transfer-limits-concurrency.test.ts` — dynamic transfer-risk + concurrency regression driven through the REAL gateway/`@/agent` façade and Banking SDK: two DISTINCT ¥600 transfers parked & confirmed concurrently → exactly ONE executes and `computeDailyTransferTotal(userId) ≤ 1000` with the loser escalated (`awaiting_mfa`, `requiresMfa`, tier `RED`); cross-session accumulation of the USER-scoped day total; the exactly-¥1000 boundary (allowed) vs ¥1001 (escalates); 3+ queued transfers preserve the ≤¥1000 invariant; repeat confirm of the SAME action → `CONFLICT` with exactly one execution; balance/ledger consistency (success ⇒ exactly one debit + one ledger row; concurrent insufficient balance ⇒ no overspend). DB-backed, unique persisted session.

**Injection**
- `injection-guard.test.ts` — `scan` (pure, `INJECTION_PATTERNS` table) + `reportInjection` (DB writes an `INJECTION_ATTEMPT` SecurityEvent; no-op when benign).

**Circuit breaker**
- `circuit-breaker.test.ts` — `getState`/`isLocked`/`recordFailure`/`recordSuccess`/`reset`; trips at `MFA_MAX_ATTEMPTS = 3`. In-process, keyed by `sessionId`.
- `circuit-breaker-audit.test.ts` — `CIRCUIT_BREAKER_TRIPPED` event completeness + a tripped breaker DENIES EVERY tier (incl. GREEN reads) via `gateway.evaluate`/`decide`. DB-backed, unique sessionId.
- `circuit-breaker-reset.test.ts` — the `resetSession()` unlock path clears in-memory state + records a `SECURITY_RESET` event. DB-backed, unique sessionId.

**MFA**
- `mfa.test.ts` — `issueChallenge`/`verify`/`getChallenge`; `MFA_CODE = '123456'`; code-free views. Needs test SQLite.
- `mfa-audit.test.ts` — `MFA_FAILURE` event completeness (decision `reject_code`, outcome `attempt_counted`|`session_locked`, threshold counts). DB-backed, unique sessionId.

## Constraints

- `permission-engine` and `injection-guard.scan` are PURE (no DB/network) — assert determinism.
- Breaker state is in-process keyed by `sessionId`: use a **unique sessionId** per test (session isolation is asserted too).
- Never assert that a tier depends on model/user text — that is the whole point of the model.
- Import frozen types from `@/lib/contracts/*`; assert through the public facades.
- DB-backed specs call `useFreshDatabase()` once (file-level `beforeEach` reset+seed).

## Notes for Agents

- Helper imports use the correct relative path from this node: `../../helpers/db` and `../../helpers/fixtures` (`../../helpers/scenario` for `newSessionId`), NOT `../helpers/*`.
- DB-backed specs set `vi.setConfig({ hookTimeout: 60_000 })` — the `useFreshDatabase()` per-test truncate+seed is I/O-heavy and can exceed Vitest's 10 s default hook timeout on Windows. This is a local workaround; the root-owned `vitest.config.ts` still has no global `hookTimeout`.
- Gateway persistence facts the specs assert: `createPendingAction` persists YELLOW as status `'pending'` (there is no `'awaiting_confirmation'` value in `PendingActionStatus`) and RED as `'awaiting_mfa'`; `parseBlockReason` returns `{ actionId, decisionKind }` (field is `decisionKind`).
- `securityGateway.authorizeAction`/`cancelAction` REQUIRE non-optional `{ userId, sessionId }` ownership (no demo-user fallback; missing/mismatching → `AppError('SECURITY_DENIED')`), and `NOT_FOUND` is still checked first. Specs pass `{ userId: DEMO_USER_ID, sessionId }`, where `sessionId` is the session the action was parked with. On execution-time re-risk escalation a parked YELLOW transfer is persisted as `'awaiting_mfa'` (tier `RED`, `requiresMfa: true`) and returned as `{ ok:false, status:'awaiting_mfa', tier:'RED', requiresMfa:true, code:'LIMIT_EXCEEDED' }`.
- `computeDailyTransferTotal(userId, now?)` resolves the window as `[startOfDay(now), +∞)` — a LOWER bound only, so future-dated transfers would count; specs use a PRIOR day to test exclusion rather than a future date.
- `authorize-concurrency.test.ts` drives the REAL `@/agent` `confirmAction`/`verifyAction` façade (not just `securityGateway`), so it needs a PERSISTED session (`getOrCreateSession(DEMO_USER_ID)`) — `agent/confirmation.ts` resolves the owner from the session row; that also provides circuit-breaker isolation.

## Routing Table

- `./permission-engine.test.ts` · `./risk-engine.test.ts` · `./risk-engine-rerisk.test.ts`
- `./gateway.test.ts` · `./gateway-audit-trail.test.ts` · `./authorize-hardening.test.ts` · `./authorize-concurrency.test.ts`
- `./injection-guard.test.ts`
- `./circuit-breaker.test.ts` · `./circuit-breaker-audit.test.ts` · `./circuit-breaker-reset.test.ts`
- `./mfa.test.ts` · `./mfa-audit.test.ts`
- `../../helpers` → test-DB + fixtures for the DB-backed cases (sibling — this node)
