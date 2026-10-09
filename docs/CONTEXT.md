# docs — Competition Documentation

`repair-recovery-security.md` records the `95ff994` follow-up repair: new-debit recovery authorization,
card/subscription resource ownership, separate reconciliation audit identities and truthful recovery
responses. Its three original probes are unchanged; one older HTTP assertion is tightened to the
manual-review contract. Current suite: 113 files / 811 tests; separate browser acceptance: 7 journeys.

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
  durable-plan mechanics accurately: the INITIAL `submit_plan` run claims each node through the SAME
  atomic plan-ownership CAS a resume uses (`agent/task-control.ts#buildNodeClaimPorts` around the
  single-statement `claimNodeOwnedByPlan`, wired by `agent/tools/planning.ts#runSubmitPlan`), and a
  takeover reclaims the zombie's non-terminal nodes via `clearStaleNodeClaims`; takeover writes are
  **token-fenced**; a progressing executor renews its lease at **node boundaries**; a node claim
  verifies **plan ownership** in the same statement as the claim and refuses a **terminal** node; an
  executed gated PLAN node recovers by **backfilling the persisted `PendingAction.resultJson`** (never
  re-invoking the tool), while a STANDALONE wedge is settled by the reference-counted `liveConfirmations`
  registry + `recoverStandaloneWedge` (idempotent replay of `transfer_money`, else terminal
  `needs_reconciliation`). §6/§9 document the **unified evidence-based convergence** decider
  (`agent/execution-convergence.ts#decideConvergence(action, opts?)`, shared by standalone / plan-linked
  / confirm-MFA / exception / recovery paths; plan-link execution identity `nxe:<taskId>:<nodeId>` from
  `lib/ledger.ts#ledgerKeyForAction`), the **SDK write-boundary execution fence**
  (`banking-sdk/fence.ts#EXECUTION_FENCE` + `attachExecutionFence` — attaches a non-enumerable Symbol
  prop and returns the **SAME object reference** — + `readExecutionFence`; `agent/execution-fence.ts#buildPlanNodeFence`
  / `buildConfirmFence`), re-checked **INSIDE the DB transaction** before the business write, and the
  **in-tx digest replay** (`banking-sdk/transfer.ts#replayCommitted`) where the debit + ledger
  `Transaction` + `ExecutionReceipt` commit in ONE `prisma.$transaction`; the additive **upgrade/compat**
  note (`ExecutionReceipt` + `AuditLog.dedupeKey` applied via `prisma db push`; NO `migrations/` directory;
  consistency never resolved by wiping/re-seeding).
- `docs/security.md` — three permission tiers + the frozen policy table + dynamic `transfer_money`
  rules (`DAILY_TRANSFER_LIMIT=1000`); the Security Gateway `beforeToolCall` chokepoint;
  code-enforced / LLM-immutable permissions; prompt-injection defense (`injection-guard`, Test 4);
  hallucination protection (facts only from tool results); MFA (`MFA_CODE='123456'`,
  `MFA_MAX_ATTEMPTS=3`); circuit breaker; audit log fields (`AuditEntry` / `SecurityEventKind`);
  the **reliable/keyed audit** contract (`audit/audit-logger.ts#recordAudit(entry, {client, dedupeKey, strict})` —
  `strict:true` rethrows a real insert error and ONLY absorbs a verified duplicate (P2002 on the exact
  `dedupeKey` AND a row with that key already present); `AuditLog.dedupeKey` is `String? @unique`; the
  debit/ledger/receipt and the necessary execution audit commit in the SAME transaction, so an audit failure
  rolls back the business write; historical "posted but missing audit" rows support idempotent backfill —
  no re-debit, never `executed`→`failed`); session identity (cookie-only write endpoints); the
  **SDK write-boundary execution fence** (§5/§6: cancel-first blocks the old executor's write, business-commits-first
  retains the real fact, pause contract preserved — pause blocks later nodes and the plan stays `paused` after a
  gated node's confirmation completes); plan-lifecycle guarantees (cancel revokes parked actions / no fake rollback /
  exactly-once resume-retry, with the INITIAL `submit_plan` run fenced through the same plan-ownership node claim as
  a resume); the standalone `needs_reconciliation` outcome (manual reconciliation of a possibly-committed,
  non-replayable side effect); sandbox guarantees. §14 is the honest **三桶自评** (已实现 / 模拟 / 未验证) for the
  security surface.
- `docs/test-cases.md` — the 12 demo scenarios as a table (input / tier / behavior / spec file);
  the four test layers (pure unit / faux-LLM scenario / in-process route-handler `[integration]` /
  real-browser acceptance harness `tests/e2e`, run via tsx, not vitest)
  and the regression categories they cover (concurrency & limits, cumulative-risk dedup, identity &
  session, MFA escalation, DAG pause/cancel/resume/refresh, mock action routing, injection, shared
  kernel); the offline `LLM_MODE=mock` + `fauxProvider` determinism story; run commands.
  §1/§4 list the frozen regression probes (`tests/integration/node-result-recovery.test.ts`,
  `tests/integration/node-recovery.test.ts`) plus the frozen acceptance spec
  `tests/integration/confirmation-continuation.test.ts` (4 tests), the invariant-grouped boundary/integrity/fencing
  specs (`tests/integration/execution-integrity.test.ts`, `tests/integration/execution-integrity.test.ts`,
  `tests/integration/executor-leases.test.ts`, `tests/app/confirm-continuation-fencing.test.ts`) and the
  executor-fencing / marker-lifecycle / standalone-recovery specs
  (`tests/integration/initial-executor-fencing.test.ts`, `tests/integration/confirmation-liveness.test.ts` —
  now asserts a committed receipt converges to **executed/success**, `tests/integration/standalone-recovery.test.ts`)
  plus the receipt/barrier/refresh recovery specs (`tests/integration/action-refresh.test.ts`,
  `tests/integration/transfer-history.test.ts`, `tests/integration/transfer-receipts.test.ts`,
  `tests/integration/action-refresh.test.ts`, `tests/integration/execution-barriers.test.ts`,
  `tests/app/actions-recovery-http.test.ts`) and the **unified-boundary regression specs**
  (`tests/integration/committed-outcomes.test.ts`, `tests/integration/committed-outcomes.test.ts`,
  `tests/integration/transfer-replay.test.ts`, `tests/integration/takeover-controls.test.ts`,
  `tests/integration/execution-audit.test.ts`, `tests/integration/restart-recovery.test.ts`); §6 (test-infra)
  records the clean-env init root cause (`RUST_LOG`), further specs (`tests/integration/node-result-recovery.test.ts`,
  `tests/integration/obsolete-executor.test.ts`, `tests/integration/node-result-recovery.test.ts`, `tests/deploy-db-push.test.ts`,
  `tests/unit/lib/prisma-cli-env.test.ts`) and the deploy ordering (`npm run db:push` → `db:seed` → `build`);
  the maintained suites now live in tests/integration; current size is **113 files / 811 tests**.
- `docs/known-risks.md` — honest limitations (mock data, simulated MFA, no real payment, heuristic
  anomaly detection, fictional investments, spending analysis excludes anomalies, pinned demo clock,
  limited audit scope, non-deterministic live LLM), each tagged with
  exactly one of the three buckets and framed as *limitation + why it is acceptable for a
  competition demo*; carries the 【已实现】 entries for the unified convergence / write-boundary fence /
  in-tx digest replay / strict-keyed audit and the 【未验证】 multi-instance caveat (summary-table rows 17–19,
  §17–§19). Documents the standalone `needs_reconciliation` reconciliation boundary (only
  `transfer_money` is proven idempotent for standalone recovery), the per-process ref-counted
  `liveConfirmations` liveness registry (with the persisted per-row execution lease,
  `EXECUTION_LEASE_TTL_MS = 120000`, distinct from the plan-takeover `EXECUTION_CLAIM_TTL_MS = 600000`),
  the receipt-first idempotent settlement (`ExecutionReceipt` + `replayCommitted`), the `/actions` page
  and the `POST /api/actions/[id]/recover` route, the additive upgrade/compat story (`ExecutionReceipt` +
  `AuditLog.dedupeKey` via `prisma db push`, no `migrations/`, never resolved by wiping/re-seeding), the
  clean-env init root cause, the `lib/prisma-cli-env.ts` policy and the deploy ordering as an engineering note,
  together with the file-size soft-guideline overrun.

## Constraints

- **Accurate to the implemented code.** Reference only real paths/constants/tool names; if the code
  contradicts the root objective's wording, follow the code (and note the divergence in the commit
  message, not in the docs).
- **Docs only.** This node owns no code; never modify `lib/contracts`, modules, tests or the root
  `CONTEXT.md` from here — documentation of other nodes is theirs.
- Markdown with headings, pipe-aligned tables and fenced ` ```mermaid ` code blocks; money in `¥`.
- Keep each doc focused; no fluff. Root routing-table entries and code are the source of truth.
- **No changelog language.** Describe current state only — no "was X now Y", no "fixed"/dated entries;
  git history is the change log.

## Routing Table

- `./architecture.md` → system architecture, layers, Context Tree, Pi Agent/SDK/Tools/Planner deep dives, convergence + fence + replay mechanics, diagrams
- `./security.md` → permission tiers, gateway, injection/hallucination defense, MFA, circuit breaker, strict/keyed audit, write-boundary fence, sandbox
- `./test-cases.md` → 12 demo scenarios + unit coverage + offline/mock test strategy + real-browser acceptance harness + regression specs
- `./known-risks.md` → honest limitations, each tagged with one of the three buckets + demo acceptability rationale
- `../tests/e2e/CONTEXT.md` → real-browser acceptance harness (journeys + honest caveats; sibling — read-only)
- `../CONTEXT.md` → root context (pipeline, tech stack, security model, tool catalogue) — source of truth (read-only)
- `../README.md` → setup, demo account, mock MFA code, demo script (root-owned, sibling — read-only)

## Notes for Agents

- Constants cited here come from `lib/constants.ts`: `DAILY_TRANSFER_LIMIT`, `MFA_CODE`,
  `MFA_MAX_ATTEMPTS`, `ANOMALY_AMOUNT_THRESHOLD`, `DEFAULT_DEMO_USER_ID`, `DEMO_NOW`, `RISK_LABEL`.
- The 26-tool catalogue mirrors `lib/contracts/tools.ts` (`ToolName` union = 26) and
  `security/permission-engine.ts` (the authoritative tier table); `agent/tools/planning.ts#KNOWN_TOOL_NAMES` is 25 (excludes the `submit_plan` meta-tool).
- Scenario spec filenames mirror `tests/scenarios/test-0X-*.test.ts` (12 files).
- When the code changes, update these docs in the same commit — they describe current state.
- A real-browser acceptance harness exists at `tests/e2e/` (system Chrome via `playwright-core`, run
  explicitly via `npx tsx tests/e2e/acceptance.e2e.ts`, never collected by vitest); the docs may
  describe it but must NOT claim it proves the security model fully closed — it is a limited
  single-machine acceptance (see `../tests/e2e/CONTEXT.md`).
- **Three-bucket convention**: tag every limitation with exactly one of ✅ 已实现 / 🧪 模拟 /
  ⚠️ 未验证·未完成. Never let a doc claim more than the code proves.
- **Unified convergence decider** (`agent/execution-convergence.ts#decideConvergence(action, opts?)`):
  the single evidence-based arbitration shared by standalone actions, plan-linked actions, confirm/MFA,
  exception handling and recovery. It must NOT infer failure from a missing `resultJson`, a lost in-process
  marker, or a caught exception. Priority: verified committed `ExecutionReceipt` (plus its ledger row) →
  `executed`, reusing the ORIGINAL result (never re-executed); live execution lease / in-process marker →
  `processing`; only a proven no-side-effect failure → `failed`; unknown outcome → `needs_reconciliation`.
  Plan-linked execution identity is `nxe:<taskId>:<nodeId>`. A cancelled plan MAY have an already-posted
  action's status corrected, but the plan is never resumed and no downstream node starts.
- **SDK write-boundary fence** (`banking-sdk/fence.ts`): `EXECUTION_FENCE` Symbol, `attachExecutionFence(input, check)`
  (attaches a non-enumerable Symbol prop and returns the **SAME object reference** so it survives wrappers that
  forward only the first argument), `readExecutionFence`. The fence runs **INSIDE the DB transaction** and, before
  the business write, re-reads the persisted plan/node `executionToken` + `generation` + status and throws
  `AppError('CONFLICT')` on token rotation / generation change / cancel / wrong state. `agent/execution-fence.ts`
  exposes `buildPlanNodeFence(taskId, nodeId)` and `buildConfirmFence` (a confirm authenticates with the ACTION's own
  lease/live continuation + "owning plan not cancelled", NOT the plan's rotated token). Applied to `reserve_budget`
  (`banking-sdk/budget.ts`) and `transfer`. Out-of-transaction checks are NOT the final guarantee.
- **Transaction-fact-first settlement** (`banking-sdk/transfer.ts`): the debit, ledger `Transaction` and
  `ExecutionReceipt` commit in ONE `prisma.$transaction`; on replay the committed receipt is read INSIDE the tx and
  `requestDigest` is verified — same key + same request → the ORIGINAL result; same key + DIFFERENT request →
  `AppError('CONFLICT')` with no new side effect; no receipt → `CONFLICT`. Receipt-less legacy ledger rows
  (deterministic `idempotentTransferTxId`) are still recognized as already-posted; it never stitches the current
  request's recipient/amount onto an existing ledger row.
- **Reliable/keyed audit** (`audit/audit-logger.ts#recordAudit(entry, {client, dedupeKey, strict})`): `strict:true`
  (used for execution/recovery audits) rethrows a real insert error and ONLY absorbs a verified duplicate (P2002 on
  the exact `dedupeKey` AND a row with that `dedupeKey` already present). `AuditLog.dedupeKey` is `String? @unique`.
- **Frozen regression invariants** (locked by the frozen acceptance spec
  `tests/integration/confirmation-continuation.test.ts` — 4 tests — alongside
  `tests/integration/node-result-recovery.test.ts` — 2 tests — and `tests/integration/node-recovery.test.ts` —
  3 tests): (a) executed-node recovery **backfills** the persisted `PendingAction.resultJson` and
  **never re-invokes the tool**; (b) takeover writes are **token-fenced** (a taken-over zombie cannot
  forge/overwrite node/plan results). Describe these two invariants exactly; do NOT generalise them
  into blanket "replay never duplicates side effects".
- **Execution fencing covers every executor path** (initial `submit_plan` run, dependency-skip,
  condition/note nodes, confirm-continuation) via a single-statement CAS on the node/plan execution
  token: the INITIAL run claims each node through `agent/task-control.ts#buildNodeClaimPorts` (the
  SAME single-statement plan-ownership CAS `claimNodeOwnedByPlan` a resume uses), and a takeover
  reclaims the zombie's non-terminal nodes via `clearStaleNodeClaims`; only the deliberate
  `pauseTask`/`cancelTask` ("control") writes are unfenced. When the confirm-continuation loses the
  plan claim it records the decided node through `agent/task-fencing.ts#recordDecidedNodeFenced`
  (no-owner CAS) — the human decision is never lost. The execution **result and terminal action
  status** are written in one atomic `prisma.$transaction`.
- **Takeover wording**: takeover happens only when the claim is **provably stale** (TTL
  `EXECUTION_CLAIM_TTL_MS = 600000`, real `Date.now()`); a *progressing* executor keeps its claim
  fresh via **node-boundary renewal** (`renewTaskExecutionClaim`); a zombie's **writes are fenced**.
  A process **blocked a long time inside a single tool call** can still be overtaken and may still
  attempt (fenced, side-effect-free) work — never claim "a live owner is never preempted".
- **Unclosed defects** (do NOT claim every execution path is safe): (a) the reference-counted
  `liveConfirmations` markers are **per-process** — a `confirmed` +
  `resultJson=null` row owned by a live continuation in a **different process/instance** is not
  recognized (multi-instance deploy uncovered); (b) the execution-claim takeover is a **TTL heuristic**
  (a single tool call blocked beyond `EXECUTION_CLAIM_TTL_MS` can be overtaken; multi-process contention
  is not stress-tested — atomicity is verified only within a single process/DB); (c) `agent/task-control.ts`
  (~1212 lines) and `agent/confirmation.ts` (~1105 lines) exceed the ~1000-line soft guideline
  (extraction candidates); (d) only `transfer_money` is PROVEN idempotent for STANDALONE recovery —
  every other standalone gated write settles to `needs_reconciliation` (manual reconciliation) rather
  than being replayed.
- **Clean-env init root cause (`RUST_LOG`)**: the shared policy (`SCHEMA_ENGINE_RUST_LOG`, `pinSchemaEngineLogging`, `prismaCliEnv`, the CLI/root/bin resolvers) lives in the non-test module `lib/prisma-cli-env.ts`, re-exported by `tests/helpers/prisma-cli.ts` (public API unchanged). It
  forces `RUST_LOG=info` on the Prisma schema-engine child; an ambient `RUST_LOG≥warn` had suppressed
  the engine's INFO banner, so Prisma's CLI error mapper dropped the real error line and surfaced an
  empty `Error: Schema engine error:`. Default `npx vitest run` and default E2E now auto-provision the
  isolated DB. Do NOT describe this as open/unresolved.
- **Deploy & upgrade ordering**: `npm run db:push` (`tsx scripts/db-push.ts`, pins `RUST_LOG=info`) →
  `npm run db:seed` → `npm run build` (the build prerenders routes that query SQLite). The `ExecutionReceipt`
  model and `AuditLog.dedupeKey` are additive and applied via `prisma db push` (there is NO `migrations/`
  directory); consistency is NEVER resolved by wiping or re-seeding the DB.
- **Measured state**: cleanup validation → 113 files / 811 tests pass and typecheck → 0 errors.
  Previous functional validation: build → exit 0; E2E → PASS 7 / FAIL 0 / SKIP 0. Cleanup does not
  change production logic, and did not rerun build/browser acceptance. See docs/test-cases.md.
