# tests/unit/agent — agent confirmation-flow & provider specs

## Intent

DB-backed, offline specs for the **two-phase confirmation flow** and the **offline mock model's
brain**. They exercise the REAL production pieces — `@/agent` (`confirmAction`/`verifyAction`/
`cancelAction`/`resumeTurn`/task-control), the REAL security gateway (`security.gateway.securityGateway`),
the REAL Banking SDK and the test SQLite — and mock out ONLY the model (`LLM_MODE=mock` faux provider).
Every spec keeps the in-process circuit breaker isolated with a UNIQUE persisted session per test.

## API Surface (spec files)

- `confirmation-idempotency.test.ts` — the confirmation flow's **idempotency + ownership** boundary:
  repeated confirm, confirm-after-cancel, foreign `userId`/`sessionId` (`SECURITY_DENIED`).
- `confirmation.test.ts` — the **AuditLog** facts `agent/confirmation.ts` writes for YELLOW confirm /
  RED verify / cancel (`userRequest`, `intent`, `timestamp === demoNow()`).
- `task-control.test.ts` — `runSubmitPlan` durable persistence (`AgentTask`/`AgentTaskNode`,
  `plan.id === AgentTask.id`) + the ownership-checked control glue (`getTaskPlan`/`pauseTask`/
  `resumeTask`/`cancelTask`/`retryTask` → `NOT_FOUND` / `SECURITY_DENIED`); a paused plan persists
  status `'paused'`.
- `task-cancel-revokes.test.ts` — cancellation semantics: `cancelTask` REVOKES the plan's parked
  `PendingAction` so a LATER `confirmAction` returns `ok:false`/`cancelled` with NO money moved; a
  cancel-vs-confirm race yields AT MOST ONE effect; an already-executed node (+ its Transfer row)
  survives cancel (no fake rollback).
- `run-turn-failure.test.ts` — the continuation-failure contract: a failing tool result / a
  `continue()` rejection is never swallowed and never rephrased as a success.
- `providers/provider-mock.test.ts` — pure, DB-free spec for `@/agent/providers/mock-responder`
  (`respond(context)`): fuzzy intent → tool call, two-call recipient resolution, multi-turn reuse,
  clarifications, honest failure narration, blocked gated calls (YELLOW/RED "not executed").
- `providers/plan-limit-park.test.ts` → pins the gated `submit_plan` conditional plan
  (`analyze` → `check` → `setlimit`, set_card_limit YELLOW) that PARKS in `waiting_confirmation`,
  then confirms.

## Idempotency / ownership coverage matrix (audited)

| Case | Status | Location |
| --- | --- | --- |
| REPEATED confirm (2nd = typed `ok:false`, single debit) | PRESENT | `confirmation-idempotency.test.ts:87` |
| CONFIRM-AFTER-CANCEL (rejected, no execution) | PRESENT | `confirmation-idempotency.test.ts:115` |
| CROSS-USER reject (`SECURITY_DENIED`, no execution) | PRESENT | `confirmation-idempotency.test.ts:134` (confirm+cancel); `task-control.test.ts:190` (task paths) |
| CROSS-SESSION reject (`SECURITY_DENIED`, no execution) | PRESENT | `confirmation-idempotency.test.ts:149` |
| CANCEL-then-confirm of a TASK's parked action (revoked → `ok:false`, no execution) | PRESENT | `task-cancel-revokes.test.ts` |
| CANCEL-vs-confirm race (at most one effect) | PRESENT | `task-cancel-revokes.test.ts` |
| CONCURRENT confirm (two simultaneous → exactly one executes) | **ABSENT** | no concurrent-confirm spec in this node (see Known Gaps) |

The repeated-confirm spec asserts the second call is `ok:false` and that the funding balance and the
`auditLog` row count are unchanged (money debited exactly once); ownership specs assert
`rejects.toMatchObject({ code: 'SECURITY_DENIED' })` plus unchanged balance and `pending` status.

## Constraints

- **Load-safe**: no spec constructs Prisma at module scope. Every DB access goes through
  `getTestPrisma()` from `@/tests/helpers/db`, called INSIDE helper functions or `it` bodies
  (e.g. `confirmation-idempotency.test.ts:64,70,110`; `task-control.test.ts:88,140,170,216`;
  `run-turn-failure.test.ts:214`). `@/tests/helpers/db` resolves `lib/db/client` lazily, so importing
  it never builds a client.
- Identical DB lifecycle per file: `beforeEach(resetDatabase, 30000)` + `afterAll(disconnectTestPrisma)`;
  the `vi.spyOn` files also `afterEach(vi.restoreAllMocks)`.
- Tests target the real gateway object (`const gateway = security.gateway.securityGateway`) so a
  `vi.spyOn` on it is observed by `agent/confirmation.ts`; assertions go through the `@/agent` façade.
- The real gateway's `authorizeAction` / `cancelAction` REQUIRE non-optional `{ userId, sessionId }`
  ownership opts (a missing/mismatched identity ⇒ `SECURITY_DENIED`); a `vi.spyOn` mock wrapping
  either MUST forward `opts` to the original.
- Never weaken determinism (fake timers, shared DB state); fix the injected seam instead.

## Routing Table

- `./confirmation-idempotency.test.ts` → repeated/after-cancel/foreign-owner confirm boundary
- `./confirmation.test.ts` → AuditLog rows for confirm/verify/cancel
- `./task-control.test.ts` → submit_plan persistence + task-control ownership
- `./task-cancel-revokes.test.ts` → cancel revokes parked action / cancel-vs-confirm race / executed work preserved
- `./run-turn-failure.test.ts` → continuation-failure contract (`resumeTurn`, `confirmAction`)
- `./providers/provider-mock.test.ts` → pure `mock-responder` behaviour (regex over the LLM text)
- `./providers/plan-limit-park.test.ts` → gated `submit_plan` conditional plan (parks, then confirms)
- `../helpers/db.ts` → `getTestPrisma()` (lazy), `resetDatabase`, `disconnectTestPrisma` (sibling — this node)

## Known Gaps

- **No concurrent-confirm spec.** The repeated-confirm spec covers sequential reuse but NOT two
  simultaneous confirms racing for the same `PendingAction` (the "exactly one executes" invariant
  is unproven here). The cancel-vs-confirm race is covered by `task-cancel-revokes.test.ts`.
