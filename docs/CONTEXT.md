# docs — Competition Documentation

## Intent

The **competition-facing documentation** for the AI Banking Agent demo: precise, demo-oriented
prose (Chinese-friendly headings + English technical terms) describing the **as-implemented**
system. These docs are written from the real code and the Context Tree, not from design intent —
each references actual module paths, constants, tool names and spec files.

The audience is a Chinese competition review; the goal is to explain *why this is an agent with
code-enforced security*, not a chat skin over a bank app.

## API Surface (deliverables)

- `docs/architecture.md` — layered pipeline (Next.js Web App → Pi Agent → Planner → Tools →
  Security Gateway → Banking SDK → Prisma/SQLite), Context-Tree layout, Git-DAG versioning, and
  deep dives on **Pi Agent**, **Banking SDK**, **Tool Calling** (`createToolRegistry`, TypeBox,
  two execution paths) and the **DAG Planner**; Mermaid diagrams (pipeline + two-phase
  confirmation + DAG example) and the tool catalogue (🟢/🟡/🔴 + `submit_plan`).
- `docs/security.md` — three permission tiers + the frozen policy table + dynamic `transfer_money`
  rules (`DAILY_TRANSFER_LIMIT=1000`); the Security Gateway `beforeToolCall` chokepoint;
  code-enforced / LLM-immutable permissions; prompt-injection defense (`injection-guard`, Test 4);
  hallucination protection (facts only from tool results); MFA (`MFA_CODE='123456'`,
  `MFA_MAX_ATTEMPTS=3`); circuit breaker; audit log fields (`AuditEntry` / `SecurityEventKind`);
  session identity (cookie-only write endpoints); plan-lifecycle guarantees (cancel revokes parked
  actions / no fake rollback / exactly-once resume-retry); sandbox guarantees.
- `docs/test-cases.md` — the 12 demo scenarios as a table (input / tier / behavior / spec file);
  the three test layers (pure unit / faux-LLM scenario / in-process route-handler `[integration]`)
  and the regression categories they cover (concurrency & limits, cumulative-risk dedup, identity &
  session, MFA escalation, DAG pause/cancel/resume/refresh, mock action routing, injection, shared
  kernel); the offline `LLM_MODE=mock` + `registerFauxProvider` determinism story; run commands.
- `docs/known-risks.md` — honest limitations (mock data, simulated MFA, no real payment, heuristic
  anomaly detection, fictional investments, spending analysis excludes anomalies, in-process
  breaker, pinned demo clock, limited audit scope, non-deterministic live LLM), each tagged with the
  honest ✅ implemented / 🧪 simulated / ⚠️ unverified classification and framed as
  *limitation + why it is acceptable for a competition demo*.

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
- `./test-cases.md` → 12 demo scenarios + unit coverage + offline/mock test strategy
- `./known-risks.md` → honest limitations, each with a demo acceptability rationale
- `../CONTEXT.md` → root context (pipeline, tech stack, security model, tool catalogue) — source of truth (read-only)
- `../README.md` → setup, demo account, mock MFA code, demo script (root-owned, sibling — read-only)

## Notes for Agents

- Constants cited here come from `lib/constants.ts`: `DAILY_TRANSFER_LIMIT`, `MFA_CODE`,
  `MFA_MAX_ATTEMPTS`, `ANOMALY_AMOUNT_THRESHOLD`, `DEFAULT_DEMO_USER_ID`, `DEMO_NOW`, `RISK_LABEL`.
- The 26-tool catalogue mirrors `lib/contracts/tools.ts` (`ToolName` union) and
  `security/permission-engine.ts` (the authoritative tier table).
- Scenario spec filenames mirror `tests/scenarios/test-0X-*.test.ts` (12 files).
- When the code changes, update these docs in the same commit — they describe current state.
- There is **no browser E2E suite**: `tests/app/*` are in-process route-handler `[integration]` specs;
  the repo has no `tests/e2e/` and no Playwright/Puppeteer/Cypress/Selenium spec file;
  `playwright-core` is declared in `package.json` but unused — these docs must never claim browser
  verification.
