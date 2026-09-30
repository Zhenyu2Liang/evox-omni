# tests/unit — pure & logic unit specs

## Intent

Fast, focused unit tests for the deterministic cores of the system — the parts that decide risk,
order a plan, or enforce a domain invariant. These run **without the LLM** and, where possible,
**without a DB**, so they are the tightest, most reliable correctness net.

Current status: **fully implemented** — real assertions throughout; no `it.todo` remains.
DB-backed cases use the test SQLite via `../helpers/db`; the rest need no DB or LLM.
import Prisma-constructing modules at runtime).

## API Surface

Grouped by the source module under test (mirrors the source tree):

- `security/` — `permission-engine`, `risk-engine`, `gateway`, `injection-guard`, `circuit-breaker`, `mfa`.
- `planner/` — `dag` (validate / topological order / conditions), `executor` (runPlan).
- `banking-sdk/` — `transfer`, `subscription`, `investment`.

Runtime imports are present only as commented lines in each spec header (target module + symbols);
Phase 2 uncomments them.

## Constraints

- Pure where possible: no network, no real clock (`now` is injected), no LLM. DB-backed cases
  (`computeDailyTransferTotal`, gateway persistence, MFA challenges, SDK invariants) use the test
  SQLite via `../helpers/db` and are annotated as such in their file header.
- **Unique `sessionId`** for any breaker-related case.
- Import frozen types from `@/lib/contracts/*`; never redeclare. Assert through public facades
  (`@/security`, `@/planner`, `@/banking-sdk`).
- Do not weaken determinism (fake timers, shared state) to pass — use the injected seams.

## Routing Table

- `./security` → permission/risk/gateway/injection/circuit-breaker/MFA unit specs
- `./planner` → DAG + executor unit specs
- `./banking-sdk` → transfer/subscription/investment domain-invariant specs
- `../helpers` → shared utilities (db/fixtures) used by DB-backed unit cases (sibling — this node)
