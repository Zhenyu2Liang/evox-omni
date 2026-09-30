# tests/unit/security — security-model unit specs

## Intent

Prove the **code-enforced, LLM-immutable** security model at the unit level: tiers come from a static
policy table + dynamic rules (never from the model), transfers escalate by amount/daily-total, the
gateway serializes/parses block reasons and gates on confirmation, injection scanning never grants
permission, and the circuit breaker locks a session after 3 consecutive MFA failures.

## API Surface

Six spec files, each with **real assertions** (no `it.todo` remain), targeting `@/security/<module>` via
the `@/security` facade (`{gateway, permission, risk, mfa, circuitBreaker, injection}`):

- `permission-engine.test.ts` — `TOOL_POLICY` exhaustiveness vs the `ToolName` union, static GREEN/YELLOW/RED tiers, `getToolPolicy` (unknown → `AppError('VALIDATION')`), `evaluateTool` (GREEN no confirm/no mfa, YELLOW confirm, RED confirm+mfa; dynamic `transfer_money` delegated to the risk engine; `submit_plan` not risk-gated; LLM-immutability — whimsical/spoofed args & `ctx` never change the tier). Pure, no DB.
- `risk-engine.test.ts` — `evaluateTransferRisk` boundary at ¥1000 (`>` is strict) + `computeDailyTransferTotal` (test SQLite). Pure part has no DB.
- `gateway.test.ts` — `securityGateway.evaluate/decide/createPendingAction/serializeBlockReason/parseBlockReason/authorizeAction/cancelAction/handleToolCall` + `buildPendingActionSummary` + `BLOCK_REASON_PREFIX`. Persistence cases need test SQLite.
- `injection-guard.test.ts` — `scan` (pure, `INJECTION_PATTERNS` table) + `reportInjection` (DB writes an `INJECTION_ATTEMPT` SecurityEvent; no-op when benign).
- `circuit-breaker.test.ts` — `getState`/`isLocked`/`recordFailure`/`recordSuccess`/`reset`; trips at `MFA_MAX_ATTEMPTS = 3`. In-process, keyed by `sessionId`.
- `mfa.test.ts` — `issueChallenge`/`verify`/`getChallenge`; `MFA_CODE = '123456'`; code-free views. Needs test SQLite.

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
- `computeDailyTransferTotal(userId, now?)` resolves the window as `[startOfDay(now), +∞)` — a LOWER bound only, so future-dated transfers would count; specs use a PRIOR day to test exclusion rather than a future date.

## Routing Table

- `./permission-engine.test.ts` · `./risk-engine.test.ts` · `./gateway.test.ts` · `./injection-guard.test.ts` · `./circuit-breaker.test.ts` · `./mfa.test.ts`
- `../../helpers` → test-DB + fixtures for the DB-backed cases (sibling — this node)
