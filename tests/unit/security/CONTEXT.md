# tests/unit/security — security-model unit specs

## Intent

Prove the **code-enforced, LLM-immutable** security model at the unit level: tiers come from a static
policy table + dynamic rules (never from the model), transfers escalate by amount/daily-total, the
gateway serializes/parses block reasons and gates on confirmation, injection scanning never grants
permission, and the circuit breaker locks a session after 3 consecutive MFA failures.

## API Surface

Spec files (all `it.todo` scaffolds today), each targeting `@/security/<module>` via the `@/security` facade:

- `permission-engine.test.ts` — `TOOL_POLICY`, `getToolPolicy`, `evaluateTool` (GREEN/YELLOW/RED table; `submit_plan` ungated; `transfer_money` dynamic; unknown tool → `VALIDATION`). Pure.
- `risk-engine.test.ts` — `evaluateTransferRisk` boundary at ¥1000 (pure) + `computeDailyTransferTotal` (needs test SQLite).
- `gateway.test.ts` — `securityGateway.evaluate/decide/createPendingAction/serializeBlockReason/parseBlockReason/authorizeAction/cancelAction/handleToolCall` + `buildPendingActionSummary`. Persistence cases need test SQLite.
- `injection-guard.test.ts` — `scan` (pure, pattern table) + `reportInjection` (DB writes an `INJECTION_ATTEMPT`).
- `circuit-breaker.test.ts` — `getState`/`isLocked`/`recordFailure`/`recordSuccess`/`reset`; trips at `MFA_MAX_ATTEMPTS = 3`. In-process, keyed by `sessionId`.
- `mfa.test.ts` — `issueChallenge`/`verify`/`getChallenge`; `MFA_CODE = '123456'`; code-free views. Needs test SQLite.

## Constraints

- `permission-engine` and `injection-guard.scan` are PURE (no DB/network) — assert determinism.
- Breaker state is in-process keyed by `sessionId`: use a **unique sessionId** per test.
- Never assert that a tier depends on model/user text — that is the whole point of the model.
- Import frozen types from `@/lib/contracts/*`.

## Routing Table

- `./permission-engine.test.ts` · `./risk-engine.test.ts` · `./gateway.test.ts` · `./injection-guard.test.ts` · `./circuit-breaker.test.ts` · `./mfa.test.ts`
- `../../helpers` → test-DB + fixtures for the DB-backed cases (sibling — this node)
