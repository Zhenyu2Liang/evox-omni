# AI Banking Agent — Root Context
## Intent
A **competition demo** of an *AI Banking Agent*: the user describes a financial need in
natural language, and an AI agent understands the intent, plans tasks, calls *banking tools*,
and completes operations under a strict, **code-enforced** permission & security model.
The agent has the loop **理解 → 规划 → 执行 → 风控 → 验证 → 审计**
(understand → plan → execute → risk-control → verify → audit).
It is **NOT** a chat skin over a bank app. It is an agent with autonomous planning, tool
calling, security gating, task orchestration and auditing.
Hard scope limits (demo sandbox): **no real bank, no real money, no real payments, no shell,
no arbitrary code/SQL/file access by the model.** All banking data is simulated in SQLite.
Core principle, stated everywhere: **The agent may decide *what to do next*; the agent may NEVER
decide *whether it is allowed to do it*. Permission is decided by TypeScript code, never by the LLM.**
## System Architecture
```
User
 ↓  Next.js Web App (React + Tailwind + Recharts)
 ↓
Pi Agent  (@mariozechner/pi-agent-core Agent + @mariozechner/pi-ai)
 │   intent understanding · context · planning · tool calling · NL reply
 ↓
Agent Planner (planner/ — DAG)
 ↓
Custom Banking Tools (agent/tools — registered, schema-validated)
 ↓
Security Gateway (security/security-gateway.ts)  ← beforeToolCall hook
 │   权限判断 → 🟢/🟡/🔴 → 确认 / 验证码 / 熔断
 ↓
Banking SDK (banking-sdk/)
 ↓
Prisma → SQLite
```
Security flow:
```
Pi Agent → Tool Request → Security Gateway → permission tier (GREEN/YELLOW/RED)
        → confirm / MFA → Banking SDK → execute → Audit Log
```
## Tech Stack (frozen)
- **TypeScript** end-to-end. No Python / FastAPI / Java. No microservices.
- Frontend: **Next.js (App Router) + React + Tailwind CSS + Recharts**.
- Agent: **`@mariozechner/pi-agent-core` (^0.73.1)** + **`@mariozechner/pi-ai` (^0.73.1)**.
  Tool schemas use **TypeBox** (`Type`, `Static` re-exported by pi-ai).
- Persistence: **Prisma + SQLite**.
- Validation: **zod** (API boundaries) + TypeBox (tool params).
- Tests: **Vitest**.
## Pi Agent Integration (design decisions — READ THESE)
The Pi Agent is used strictly as **Agent Runtime + Planner + Tool Caller**. It is constructed with
ONLY the registered banking tools. There is **no** bash/shell/write/edit/file/SQL tool registered —
so injection that asks for one simply has no tool to call.
Concrete SDK facts the implementation relies on (verified against pi-agent-core 0.73.1):
- `new Agent({ initialState, beforeToolCall, afterToolCall, convertToLlm, transformContext, sessionId, ... })`.
- `AgentTool<TParams>` = `{ name, description, parameters (TypeBox), label, execute(toolCallId, params, signal, onUpdate) }`.
  `execute` returns `AgentToolResult<T> = { content: (Text|Image)[], details: T, terminate? }` and **throws on failure**.
- `agent.prompt(input)` / `agent.continue()` return when the run settles; `agent.subscribe(listener)` streams
  `AgentEvent` (`agent_start|agent_end|turn_start|turn_end|message_start|message_update|message_end|tool_execution_start|tool_execution_update|tool_execution_end`).
- **`beforeToolCall` is the security chokepoint.** Returning `{ block: true, reason }` prevents execution and
  emits an error tool-result to the model. This is how GREEN/YELLOW/RED is enforced *in code*: the model
  literally cannot execute a gated tool.
- `AgentState` (`systemPrompt`, `model`, `tools`, `messages`) is JSON-serializable → persisted per session.
- **`registerFauxProvider()`** (from pi-ai) provides a scripted in-memory model. We use it for the
  deterministic **offline/mock LLM mode** and all agent tests — same Agent/tool/security pipeline, only
  the model is scripted.
### Two-phase execution (the confirmation model)
1. **Turn**: `POST /api/chat` runs one Agent turn.
   - GREEN tool → executes inline (inside `execute`), result flows back to the model.
   - YELLOW/RED tool → `beforeToolCall` **blocks** it, persists a `PendingAction` row, and returns a
     structured reason. The model sees "awaiting user confirmation/verification" and replies to the user.
2. **Human decision**: `POST /api/actions/:id/confirm` (YELLOW, or RED after MFA) / `.../verify` (RED MFA code)
   / `.../cancel`.
   - The server executes the **original validated args** through the Banking SDK via the gateway's *authorized
     execution path* (NOT the LLM), writes the audit log, injects the **real** tool result into the session,
     and calls `agent.continue()` so the model narrates the factual outcome.
Consequence: money-moving calls are always triggered by a human confirmation, never by the model text.
This is exactly what demo **Test 4** (prompt injection) proves.
### Durable plan execution (current behavior)
- **Cancellation only blocks not-yet-authorized/executed work.**
  Cancelling a plan atomically revokes its **not-yet-authorized/executed** `PendingAction`s and marks the plan `cancelled` in one transaction.
  A successfully posted side effect keeps its action at `executed` and is **retained** — never rolled back or cosmetically reverted; the ledger, the action status and the API response stay consistent.
- **Executed-node recovery** (`agent/confirmation.ts`): when a plan resumes and a gated node's `PendingAction` is already `executed` (side effect posted, node result not yet persisted), the node's `success` is backfilled by `recoverExecutedPlanAction` from the **persisted** `PendingAction.resultJson` written by `executeAuthorizedAction` — the tool is **never re-invoked**.
  Recovery is **generic** across all gated write tools and **idempotent** (no extra write, no fresh confirmation, no duplicate side effect).
  A `confirmed` action that already has a stored result is finalized on resume via a single CAS (`confirmed` → `readStoredResult(existing)?.ok===true ? 'executed' : 'failed'`, via `claimPendingAction`) plus the same backfill — no re-run, no fabricated rollback; `ok:false` settles action + node + plan at `failed`.
  An `executed` action that has **no** stored result (legacy/pre-upgrade row) is also **not** re-invoked; the node settles with an explicit "executed but no stored result — needs manual reconciliation" outcome.
  When the SDK side effect commits but the result+status `$transaction` rolls back (a `confirmed` row stuck with `resultJson=null`), the action is finalized `failed` and routed to explicit manual reconciliation (message contains `人工核对`); the tool is never re-invoked and the plan is never left `waiting_confirmation`.
  A new in-process `inFlightConfirmations` registry (mirroring `inFlightExecutions`) distinguishes a genuine wedge (no live continuation) from a `confirmed`+null row still owned by a live continuation (re-parked, no write) — see `agent/confirmation.ts#executeGatedToolOnce`.
  `pending` / `awaiting_mfa` still await the real human decision.
- **The execution result and the terminal action status are written in ONE atomic `prisma.$transaction`** (`agent/confirmation.ts#executeAuthorizedAction`), closing the window where a saved result could be stranded at `confirmed` / `waiting_confirmation`.
- **Executor write FENCING** (`agent/task-control.ts` + `agent/task-fencing.ts`) covers **every** executor path: the initial `submit_plan` run, dependency-skip and condition/note nodes, and the confirm-continuation.
  Ownership is validated **atomically in the SAME DB statement as the write** (a single-statement CAS on the node/plan `executionToken`), so a resumed / lost-claim executor can no longer overwrite a takeover's node or plan result, mark a completed dependent `skipped`, or advance downstream.
  A node CLAIM and a node WRITE additionally verify **PLAN ownership** (the parent `AgentTask.executionToken` must equal this executor's plan token) in the SAME statement, and a node claim REFUSES a **TERMINAL** node (`success`/`failed`/`skipped`/`cancelled`), so a taken-over executor cannot re-claim a completed node or run its successor tool.
  A fenced-out plan write emits **no** `onPlanUpdate` (`agent/tools/planning.ts` gates the sink on the live plan claim), so no stale progress event is published; a legitimately reopened node (`retryPlan` writing `pending`) by the CURRENT plan owner is still allowed.
  `createTaskPersistence` distinguishes an explicit `mode:'executor'` (always fenced: `updateTaskNode(..., { fenceToken })` returns the `null` "lost" sentinel, `claimTaskStatus(..., { fenceToken })` returns `false`) from `mode:'control'` (the deliberate, unfenced `pauseTask` / `cancelTask` writes).
  When the confirm-continuation **loses** the plan claim it does **not** advance the plan; it records the decided node through a fenced no-owner CAS (`agent/task-fencing.ts#recordDecidedNodeFenced`) so the live owner continues and the human decision is never lost.
- **Execution takeover** (`agent/task-control.ts`): `resume`/`retry` take over a plan/node `executionToken` only when the owner is stale (`EXECUTION_CLAIM_TTL_MS = 600000ms`, computed from the **real** clock).
  A progressing executor keeps its claim fresh via **node-boundary lease renewal** (`renewTaskExecutionClaim`, never a background timer), but a **long-blocked owner can still be overtaken** (a single tool call blocked beyond the TTL), so takeover is a **TTL heuristic**, not a liveness proof. Atomicity of the takeover/claim CAS is verified only within a single process/DB; multi-process / multi-instance contention is **not** stress-tested, and the `inFlightConfirmations` registry is per-process (a live continuation in another instance is not recognized).
  The takeover is **fenced**: the overtaken executor's writes are **rejected** by the same-statement CAS, threading the claim token from `claimTaskExecution`/`buildPlanDeps`.
  Concurrent takeovers yield exactly one winner.
## Security Model (code-enforced, LLM-immutable)
Three tiers (`RiskLevel = GREEN | YELLOW | RED`), decided by `security/permission-engine.ts` +
`security/risk-engine.ts` from a **static policy table + dynamic rules** (amount, daily total), never from the model:
- 🟢 **GREEN** — low-risk reads (balance, transactions, analysis, products, cards, subscriptions). Auto-execute, no confirmation.
- 🟡 **YELLOW** — medium-risk (transfer ≤ ¥1000 & daily ≤ ¥1000, set card limit, cancel subscription, freeze card, virtual card, some scheduled tasks). **Requires user confirmation.**
- 🔴 **RED** — high-risk (transfer > ¥1000 / daily > ¥1000, investment subscribe/redeem, card loss/unfreeze report, password change). **Requires strong verification (mock MFA code `123456`).**
Additional code-level controls:
- **Circuit breaker** (`security/circuit-breaker.ts`): 3 consecutive MFA failures → the session is locked and a
  `SecurityEvent` (`CIRCUIT_BREAKER_TRIPPED`) is emitted. A tripped breaker denies **all** tiers (incl. GREEN reads, fail-closed) and is unlocked at runtime via an audited `POST /api/security/reset` → `circuitBreaker.resetSession(sessionId, {actor, reason})` which writes a `SECURITY_RESET` SecurityEvent; the synchronous `reset()` is test-only.
- **Injection guard** (`security/injection-guard.ts`): detects injection patterns in user input and records a
  `SecurityEvent` (+ a UI security event) — but **never grants permission** (defense-in-depth only). It does NOT inject a system reminder into the model context.
- **Hallucination guard**: the model may only report facts that came from a tool result. If a tool returns
  `success:false`, the agent must report failure (demo **Test 5**).
- **Audit** (`audit/`): every **gated action** (confirm / verify / cancel of a YELLOW/RED `PendingAction`)
  writes an `AuditLog` row, and every security control decision (circuit-breaker trip, injection detection,
  MFA failure) writes a `SecurityEvent`. GREEN auto-executed reads are **not** audited (see `lib/contracts/audit.ts`).
## Shared Contracts (frozen — DO NOT redefine)
All cross-module types live in **`lib/contracts/`** and are owned by the root. Child nodes IMPORT them;
they must not redeclare or fork them. Key files:
- `lib/contracts/risk.ts` — `RiskLevel`, `PermissionTier`, `TransferPolicy`, risk-policy types.
- `lib/contracts/tools.ts` — `BankingToolName` union, `ToolDescriptor`, `ToolCategory`.
- `lib/contracts/security.ts` — `SecurityEvaluation`, `SecurityDecision`, `PendingAction`, `PendingActionStatus`.
- `lib/contracts/audit.ts` — `AuditEntry`, `AuditStatus`, `SecurityEvent`, `SecurityEventKind`.
- `lib/contracts/task.ts` — `TaskNodeSpec`, `TaskNodeResult`, `TaskNodeStatus`, `TaskPlan`.
- `lib/contracts/agent.ts` — `ChatMessage`, `AgentStreamEvent`, `ChatTurnRequest`, `ChatTurnResponse`, `ChatCard`.
- `lib/errors.ts` — `AppError`, `Result<T>`, error codes.
- `lib/money.ts` — CNY formatting/parsing (`¥`, 2 decimals).
- `lib/constants.ts` — `DAILY_TRANSFER_LIMIT = 1000`, `MFA_CODE = "123456"`, `DEMO_NOW`, thresholds, demo user id.
- `lib/config.ts` — env config (LLM provider/model/key, `LLM_MODE=live|mock`, demo user).
- `lib/db/client.ts` + `lib/db/repositories/*` — Prisma singleton and typed data access.
**Error strategy**: modules return `Result<T>` (`{ok:true,value}` | `{ok:false,error:AppError}`) or throw
`AppError` at tool/SDK boundaries; the gateway/API layer translates `AppError` into a safe user message and an
audit `failed` status. Never silently swallow. Never let a raw exception reach the model.
## Demo Clock (as-of time — ROOT DECISION)
The demo pins a fixed "as-of" instant so 本月/上月/今日 windows, the spending analysis, the daily-transfer
window, scheduled-task dates and the system-prompt "today" all stay coherent regardless of the real
system clock (the stage machine's date must never break the demo).
- **`DEMO_NOW = 2026-09-25 12:00 local`** (exported from `lib/constants.ts`); `lib/clock.ts` exposes
  `demoNow(override?)` plus convenience range helpers defaulting to it (thin wrappers over `lib/date`).
- **Every running-app path that needs "now" defaults to `demoNow()`** (spend analysis window, `get_transactions`
  default range, `risk.computeDailyTransferTotal`, scheduled-task due dates, system prompt). Thread `now` as an
  explicit optional argument so tests inject a fixed clock and stay deterministic.
- The Prisma seed anchors data to **September 2026** (this month, ~¥5,800 incl. the Apple Store anomaly
  exactly at `2026-09-20 18:32`) and **August 2026** (last month, for 环比/trend). All seed dates use LOCAL
  date construction (`new Date(2026, 8, 20, 18, 32)`) so they agree with `lib/date` formatting on any tz.
## Tool Catalogue (registered tools — the ONLY capabilities the model has)
GREEN: `get_balance`, `get_transactions`, `search_contact`, `analyze_spending`, `detect_anomaly`,
`get_cards`, `list_subscriptions`, `list_investments`, `compare_investments`, `get_investment_holdings`,
`get_dashboard_summary`, `list_scheduled_tasks`, `reserve_budget`.
YELLOW: `transfer_money` (by amount/daily rule), `set_card_limit`, `cancel_subscription`, `freeze_card`,
`apply_virtual_card`, `set_subscription_reminder`, `create_scheduled_task`.
RED: `transfer_money` (amount/daily rule), `subscribe_investment`, `redeem_investment`, `report_lost_card`,
`unfreeze_card`, `change_password`.
Planner meta-tool: `submit_plan` (validates + runs a DAG; not risk-gated).
Exact tiers live in the `security/permission-engine.ts` policy table; `transfer_money` is dynamic.
## Data Model (summary — see `prisma/schema.prisma`)
Tables: `User, Account, Transaction, Contact, Card, Subscription, InvestmentProduct, InvestmentHolding,
AgentTask, AgentTaskNode, ScheduledTask, AuditLog, SecurityEvent, AgentSession, PendingAction, MfaChallenge, Budget`.
Seed: demo user **李明** (活期 ¥23,580, 信用卡额度 ¥18,000, 本月消费 ~¥5,800), contacts
**张伟/王芳/妈妈/李华**, 20–30 transactions incl. the anomaly **Apple Store ¥6,999 @ 2026-09-20 18:32**,
3–5 investment products, 3–5 subscriptions.
## Constraints
- **File size**: keep files ≲ ~1000 lines; split by responsibility. Extract shared code to the lowest common ancestor.
- **No inter-module cycles.** Dependency direction: `lib` ← `banking-sdk` ← `agent`/`planner`/`audit`; `security`
  depends on `lib` (+ injected ports); `app`/`components` depend on everything below. `components` never imports `prisma`.
- **Money**: CNY, formatted `¥1,234.56`; all business logic uses `lib/money` helpers.
- **Determinism**: agent/security/planner tests must not require network. Use `LLM_MODE=mock` (faux provider) + test SQLite.
- **Secrets**: API keys only in `.env` (gitignored); `.env.example` documents keys. Never commit real keys.
- **No LLM chain-of-thought in the UI** — show task steps, tool status, results only.
## UI (design language)
Modern digital-banking fintech: deep-blue + white + light-grey; rounded cards, soft shadows, charts,
status badges, agent task timeline; 🟢🟡🔴 used for permission status. Amounts prefixed `¥`.
## Commands
- Install: `npm install`
- Prisma: `npm run db:generate` · `npm run db:push` (`tsx scripts/db-push.ts`, pins `RUST_LOG=info`) · `npm run db:seed`
- Dev: `npm run dev` (http://localhost:3000)
- Build: `npm run build`
- Test: `npm run test` (Vitest, mock LLM + test SQLite)
## Test Strategy
Four layers (see `tests/CONTEXT.md`): (1) pure unit tests (`tests/unit/` — security, planner, banking-sdk, lib, agent);
(2) faux-LLM scenario integration (`tests/scenarios/`, mock provider + test SQLite) proving the 12 demo scenarios;
(3) in-process route-handler HTTP integration (`tests/app/*-http.test.ts`, real handlers + real test SQLite) plus
root review specs (`tests/review-*.test.ts`); (4) real-browser e2e acceptance (`tests/e2e/acceptance.e2e.ts`,
playwright-core-driven on an isolated `prisma/e2e.db`, run via `npx tsx`, not Vitest).
Clean-env bootstrap (`tests/setup.ts`, Vitest `setupFiles`): self-bootstraps a **usable** Prisma Client (usability probe) and provisions the **isolated** `prisma/test.db` **fail-loud**, keyed on a **sha1 marker of `prisma/schema.prisma`** so the schema is re-pushed **only when it changes**; `prisma/dev.db` is untouched.
Cold-start provisioning pins `RUST_LOG=info` for the Prisma schema-engine child process (`lib/prisma-cli-env.ts#pinSchemaEngineLogging`, re-exported by `tests/helpers/prisma-cli.ts`), because an ambient `RUST_LOG` at/above `warn` suppresses the engine's INFO banner and makes Prisma drop the real (line-1) error, surfacing as the opaque empty `Error: Schema engine error:` on a fresh SQLite file.
The same pin is the shipped deploy path: `npm run db:push` → `scripts/db-push.ts` (also sets `RUST_BACKTRACE=1`, resolves the local Prisma CLI, passes extra args through, exits with the child's code); `db:reset` = `tsx scripts/db-push.ts --force-reset && tsx prisma/seed.ts`.
With that pin the DEFAULT `npx vitest run` and the DEFAULT browser E2E auto-provision the isolated DB — no manual prep, no skip flag, no pre-written marker.
## Known Issues (open / unclosed)
- **Plan-ownership & write fencing are enforced in-process on a single SQLite DB.** Atomicity of the takeover/claim CAS is verified only within a single process/DB; multi-process / multi-instance contention is not stress-tested.
- **`inFlightConfirmations` is per-process.** A `confirmed` + `resultJson=null` row whose live continuation runs in a different process/instance is not distinguished from a genuine wedge (multi-instance deploy not covered).
- **Execution takeover is a TTL heuristic** (`EXECUTION_CLAIM_TTL_MS = 600000ms`, real clock): a single tool call legitimately blocked beyond the TTL can be overtaken (its writes are fenced, but it is preempted).
- **File-size soft guideline exceeded**: `agent/task-control.ts` (~1169 lines) and `agent/confirmation.ts` (~1006 lines) — extraction candidates.
## Routing Table
- `./app` → Next.js App Router: pages (dashboard, agent chat, bills, cards, subscriptions, security center, audit) + API route handlers (chat/SSE, actions confirm|verify|cancel, tasks control, audit, security, read models)
- `./components` → React UI: chat cards (balance/transfer/confirm/MFA/anomaly/plan), charts, banking tiles, ui primitives
- `./agent` → Pi Agent runtime: banking agent wiring, system prompt, session store, tool registration, LLM providers (live + faux), confirmation continuation
- `./banking-sdk` → Banking capabilities (account, transaction, transfer, card, subscription, investment, task, budget) over Prisma
- `./security` → Security Gateway + permission engine, risk engine, MFA, circuit breaker, injection guard
- `./planner` → DAG task planner + executor (`submit_plan` backing)
- `./audit` → Audit logger + security-event recorder
- `./lib` → Shared kernel: contracts, errors, money, config, constants, clock, ledger, prisma-cli-env, Prisma client + repositories
- `./prisma` → Prisma schema + seed data (applied via `prisma db push`; NO `migrations/` directory)
- `./tests` → Four layers: unit (security/planner/sdk/lib/agent) + faux-LLM scenario integration + in-process route-handler HTTP integration (`app/*-http.test.ts`, `review-*.test.ts`) + real-browser e2e acceptance (`e2e/`, isolated `prisma/e2e.db`)
- `./docs` → Competition docs: architecture.md, security.md, test-cases.md, known-risks.md (sibling — read-only, escalate writes here to root)
- `./scripts` → Deploy scripts: `db-push.ts` (pins `RUST_LOG=info` for the Prisma schema-engine, resolves the local CLI, passes extra args through, exits with the child's code)
- `./README.md` → setup, demo account, mock MFA code, demo script, known limits (sibling/root-owned)

## Notes for Agents
- The 12 demo scenarios are the acceptance bar. Every module should make its scenario work end-to-end.
- Never add a tool that moves money without routing it through the gateway's `beforeToolCall` policy.
- If you need a new shared type, add it under `lib/contracts/` (root-owned) — do not define it locally.
- For any "now" in the running app, use the demo clock (`lib/clock.ts` → `demoNow()`), never raw `Date.now()`.
