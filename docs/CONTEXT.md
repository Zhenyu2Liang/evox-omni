# docs — Competition Documentation

## Intent

The **competition-facing documentation** for the AI Banking Agent demo: precise, demo-oriented
prose (Chinese-friendly headings + English technical terms) describing the **as-implemented**
system. These docs are written from the real code and the Context Tree, not from design intent —
each references actual module paths, constants, tool names and spec files.

The audience is a Chinese competition review; the goal is to explain *why this is an agent with
code-enforced security*, not a chat skin over a bank app.

Every limitation is tagged with **exactly one** of three buckets, used consistently across all four
docs: ✅ **已实现 / implemented** (code-enforced, LLM-immutable), 🧪 **模拟 / simulated**
(mock backend or deliberately limited design), ⚠️ **未验证·未完成 / unverified·open** (not proven
in this repo, or dependent on a specific runtime environment such as multi-process/multi-instance).

## API Surface (deliverables)

- `docs/architecture.md` — layered pipeline (Next.js Web App → Pi Agent → Planner → Tools →
  Security Gateway → Banking SDK → Prisma/SQLite), Context-Tree layout, Git-DAG versioning, and
  deep dives on **Pi Agent**, **Banking SDK**, **Tool Calling** (`createToolRegistry`, TypeBox,
  two execution paths) and the **DAG Planner**; Mermaid diagrams (pipeline + two-phase
  confirmation + DAG example) and the tool catalogue (🟢/🟡/🔴 + `submit_plan`). §8/§11 state the
  durable-plan mechanics accurately: an executed gated node recovers by **backfilling the persisted
  `PendingAction.resultJson`** (never re-invoking the tool); takeover writes are **token-fenced**; a
  progressing executor renews its lease at **node boundaries**.
- `docs/security.md` — three permission tiers + the frozen policy table + dynamic `transfer_money`
  rules (`DAILY_TRANSFER_LIMIT=1000`); the Security Gateway `beforeToolCall` chokepoint;
  code-enforced / LLM-immutable permissions; prompt-injection defense (`injection-guard`, Test 4);
  hallucination protection (facts only from tool results); MFA (`MFA_CODE='123456'`,
  `MFA_MAX_ATTEMPTS=3`); circuit breaker; audit log fields (`AuditEntry` / `SecurityEventKind`);
  session identity (cookie-only write endpoints); plan-lifecycle guarantees (cancel revokes parked
  actions / no fake rollback / exactly-once resume-retry); sandbox guarantees. §14 is the honest
  **三桶自评** (已实现 / 模拟 / 未验证) for the security surface.
- `docs/test-cases.md` — the 12 demo scenarios as a table (input / tier / behavior / spec file);
  the four test layers (pure unit / faux-LLM scenario / in-process route-handler `[integration]` /
  real-browser acceptance harness `tests/e2e`, run via tsx, not vitest)
  and the regression categories they cover (concurrency & limits, cumulative-risk dedup, identity &
  session, MFA escalation, DAG pause/cancel/resume/refresh, mock action routing, injection, shared
  kernel); the offline `LLM_MODE=mock` + `registerFauxProvider` determinism story; run commands.
  §1/§4 list the frozen regression probes (`tests/review-final-boundaries.test.ts`,
  `tests/review-recovery-probes.test.ts`) plus the invariant-grouped boundary/integrity/fencing specs
  (`tests/review-current-boundaries.test.ts`, `tests/review-execution-integrity.test.ts`,
  `tests/review-execution-fencing.test.ts`, `tests/app/confirm-continuation-fencing.test.ts`); §6 (test-infra)
  records the clean-env init fix (`RUST_LOG` root cause).
- `docs/known-risks.md` — honest limitations (mock data, simulated MFA, no real payment, heuristic
  anomaly detection, fictional investments, spending analysis excludes anomalies, in-process
  breaker, pinned demo clock, limited audit scope, non-deterministic live LLM), each tagged with
  exactly one of the three buckets and framed as *limitation + why it is acceptable for a
  competition demo*; documents the clean-env init fix as an §19 engineering note (`RUST_LOG` root cause).

## Constraints

- **Accurate to the implemented code.** Reference only real paths/constants/tool names; if the code
  contradicts the root objective's wording, follow the code (and note the divergence in the commit
  message, not in the docs).
- **Docs only.** This node owns no code; never modify `lib/contracts`, modules, tests or the root
  `CONTEXT.md` from here — documentation of other nodes is theirs.
- Markdown with headings, pipe-aligned tables and fenced ` ```mermaid ` code blocks; money in `¥`.
- Keep each doc focused; no fluff. Root routing-table entries and code are the source of truth.

## Routing Table

- `./architecture.md` → system architecture, layers, Context Tree, Pi Agent/SDK/Tools/Planner deep dives, diagrams
- `./security.md` → permission tiers, gateway, injection/hallucination defense, MFA, circuit breaker, audit, sandbox
- `./test-cases.md` → 12 demo scenarios + unit coverage + offline/mock test strategy + real-browser acceptance harness
- `./known-risks.md` → honest limitations, each tagged with one of the three buckets + demo acceptability rationale
- `../tests/e2e/CONTEXT.md` → real-browser acceptance harness (journeys + honest caveats; sibling — read-only)
- `../CONTEXT.md` → root context (pipeline, tech stack, security model, tool catalogue) — source of truth (read-only)
- `../README.md` → setup, demo account, mock MFA code, demo script (root-owned, sibling — read-only)

## Notes for Agents

- Constants cited here come from `lib/constants.ts`: `DAILY_TRANSFER_LIMIT`, `MFA_CODE`,
  `MFA_MAX_ATTEMPTS`, `ANOMALY_AMOUNT_THRESHOLD`, `DEFAULT_DEMO_USER_ID`, `DEMO_NOW`, `RISK_LABEL`.
- The 26-tool catalogue mirrors `lib/contracts/tools.ts` (`ToolName` union) and
  `security/permission-engine.ts` (the authoritative tier table).
- Scenario spec filenames mirror `tests/scenarios/test-0X-*.test.ts` (12 files).
- When the code changes, update these docs in the same commit — they describe current state.
- A real-browser acceptance harness exists at `tests/e2e/` (system Chrome via `playwright-core`, run
  explicitly via `npx tsx tests/e2e/acceptance.e2e.ts`, never collected by vitest); the docs may
  describe it but must NOT claim it proves the security model fully closed — it is a limited
  single-machine acceptance (see `../tests/e2e/CONTEXT.md`).
- **Three-bucket convention**: tag every limitation with exactly one of ✅ 已实现 / 🧪 模拟 /
  ⚠️ 未验证·未完成. Never let a doc claim more than the code proves.
- **Frozen regression invariants** (locked by `tests/review-final-boundaries.test.ts` — 2 tests —
  and `tests/review-recovery-probes.test.ts` — 3 tests): (a) executed-node recovery **backfills** the
  persisted `PendingAction.resultJson` and **never re-invokes the tool**; (b) takeover writes are
  **token-fenced** (a taken-over zombie cannot forge/overwrite node/plan results). Describe these two
  invariants exactly; do NOT generalise them into blanket "replay never duplicates side effects".
- **Execution fencing covers every executor path** (initial `submit_plan` run, dependency-skip,
  condition/note nodes, confirm-continuation) via a single-statement CAS on the node/plan execution
  token; only the deliberate `pauseTask`/`cancelTask` ("control") writes are unfenced. When the
  confirm-continuation loses the plan claim it records the decided node through
  `agent/task-fencing.ts#recordDecidedNodeFenced` (no-owner CAS) — the human decision is never lost.
  The execution **result and terminal action status** are written in one atomic `prisma.$transaction`.
- **Takeover wording**: takeover happens only when the claim is **provably stale** (TTL
  `EXECUTION_CLAIM_TTL_MS = 600000`, real `Date.now()`); a *progressing* executor keeps its claim
  fresh via **node-boundary renewal** (`renewTaskExecutionClaim`); a zombie's **writes are fenced**.
  A process **blocked a long time inside a single tool call** can still be overtaken and may still
  attempt (fenced, side-effect-free) work — never claim "a live owner is never preempted".
- **Clean-env init is FIXED with a root cause**: `tests/helpers/prisma-cli.ts#pinSchemaEngineLogging`
  forces `RUST_LOG=info` on the Prisma schema-engine child; an ambient `RUST_LOG≥warn` had suppressed
  the engine's INFO banner, so Prisma's CLI error mapper dropped the real error line and surfaced an
  empty `Error: Schema engine error:`. Default `npx vitest run` and default E2E now auto-provision the
  isolated DB. Do NOT describe this as open/unresolved.
- **Measured state** (keep current when the suite changes): `npx vitest run` → 76 files / 557 tests
  pass; `npx tsc --noEmit` → 0 errors; `npx next build` → exit 0; E2E → PASS 5 / FAIL 0 / SKIP 0.
