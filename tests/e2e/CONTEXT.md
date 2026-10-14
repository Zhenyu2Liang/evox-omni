# tests/e2e — Real-Browser End-to-End Acceptance Harness

## Intent
The top of the test pyramid: prove the AI Banking Agent demo works through a **REAL browser**
driving the **REAL Next.js app** — not just in-process route handlers. It boots the actual
`next dev` server on a free port, launches the machine's real headless **Chrome** via
`playwright-core`, types natural-language requests into the real `/agent` composer, and asserts on
**RENDERED DOM** (cards, buttons, badges, assistant text). Only the LLM is scripted
(`LLM_MODE=mock`); the app, route handlers, security gateway, banking SDK and SQLite DB are real.

The suite runs against an **ISOLATED E2E database** (`prisma/e2e.db`) — never the shared
`prisma/dev.db` — so it is self-contained and non-destructive.

This node is **self-contained** — it does not import `tests/app/*` or any `@/` alias (relative
imports + node built-ins only, to avoid tsx/tsconfig path surprises).

## API Surface
- `acceptance.e2e.ts` — the SINGLE entry point. Sets the isolated DB → resets it to the canonical
  seed → boots the app → waits for readiness → launches Chrome → runs localization, workspace and banking journeys → prints
  exactly one `PASS|FAIL|SKIP <journey> — <evidence>` line per journey → exits non-zero iff ANY
  journey FAILED (a SKIP does not fail the run).
- `helpers.ts` — shared harness (details below).
- `developer-mode.e2e-helper.ts` — opt-in diagnostics, persistent normal history, shared chat reset,
  retained bank/run evidence, confirmation cancellation and mobile modal visibility.
- `i18n.e2e-helper.ts` — Chinese default, language persistence, localized server pages and no resubmission.
- `hydration.e2e-helper.ts` — clean startup and pre-hydration browser root-attribute injection; records console errors.
- `ui-shell.e2e-helper.ts` — responsive grouped navigation, draft suggestions, IME and HTTP request IDs.
- `tool-lifecycle.e2e-helper.ts` — subscription authorization settles the original call, subsequent
  requests never render its old activity in the live panel, and reload restores terminal history.
  A DOM mutation observer checks transient flashes; `LIVE_SCENARIOS=8` runs the same journey with DeepSeek.
- `card-management.e2e-helper.ts` — native card addition/deletion, independent MFA, proposal refresh,
  idempotent receipts and audits, Agent capability exclusion, mobile layout and schedule navigation.
  `LIVE_SCENARIOS=10` runs the same journey with DeepSeek.
- `conversation.e2e-helper.ts` — natural funding explanations, small talk and scheduled-task capability
  answers, abandoned-draft isolation, refresh persistence, unchanged banking data and a later explicit
  transfer confirmation. `LIVE_SCENARIOS=11` runs the same journey with DeepSeek. Chinese prompts and
  semantic answer markers live in `conversation.zh-CN.json`; no exact live-model prose is required.
  The signed-input and analysis journey rejects negative money before generation, recalls the original
  request before/after reload, and analyzes prior subscription query data without another authorization.
  `LIVE_SCENARIOS=12` runs the same assertions with the live model.
- `screenshots/` — git-ignored failure screenshots (`.gitignore` ignores everything but itself).
- `CONTEXT.md` — this file.

Harness helpers (`helpers.ts`):
- Boot/teardown: `pickFreePort`, `startDevServer`, `waitForHealth`, `waitForAppReady`,
  `bootDevServer` (project-local Next CLI, readiness gated on `/api/health` + `/agent`, one retry on
  a fresh port), `killProcessTree` (whole-tree teardown).
- **Isolated DB**: `E2E_DB_URL` (absolute `file:` URL to `prisma/e2e.db`), `useIsolatedDatabase()`
  (sets `process.env.DATABASE_URL`), `resetDemoDatabase()` (generate-or-heal the Client → remove isolated
  DB and sidecars → plain `prisma db push` → probe → seed; FULL un-truncated CLI
  diagnostics on failure). See "Isolated E2E database".
- Browser: `resolveBrowserExecutable`/`launchBrowser`, `withPage` (fresh isolated context + failure
  screenshot + `pageerror` capture), `setActiveBrowser`/`runJourney`, `createReporter`.
- Hydration gate + navigation: `waitForComposerHydration`, `gotoAgent`, `readSsrPageError`.
- DOM interactions: `submitChat`, `clickConfirm`, `waitForConfirmCard`, `submitMfa`,
  `waitForMfaCard`/`mfaCardPresent`, `waitForStatusText`, `hasAssistantText`/`waitForAssistantText`.
- Plan card + timeline: `planCard` (selects the LAST-rendered card), `planStatus`/`waitForPlanStatus`,
  `planControlPresent`/`clickPlanControl`, `planNodeRows`, `nodeStatus`/`waitForNodeStatus`.
- Read-model HTTP helpers (SECONDARY DB/ledger checks): `getJson`, `fetchDashboardSummary`,
  `fetchLedger`, `fetchCards`, `fetchPendingActions`, `cardCategoryLimit`, `diffLedger`,
  `readSessionCookie` (+ `LedgerView`/`DashboardView`/`CardView`/`PendingActionView`/`LedgerDiff`).
- Wedge fixtures + direct-DB fact helpers (journey `f`, relative imports only): `WEDGE_ACTION_ID`,
  `WEDGE_LEDGER_KEY`, `WEDGE_TX_ID`, `WEDGE_RECEIPT_ID`, `WEDGE_AMOUNT`, `WEDGE_TIER`,
  `WEDGE_AUDIT_DEDUPE_KEY`, `WEDGE_DEMO_NOW`, plus `idempotentTransferTxId`/`executionReceiptId`/
  `requestDigest` (mirrors of the app's ledger identity). `seedStandaloneWedge({ sessionId })` inserts
  ONLY the committed wedge rows in ONE transaction (checking-account debit + DEBIT `Transaction` +
  `ExecutionReceipt` + a `PendingAction` at `status='confirmed'`/`resultJson=null`), never a
  wipe/re-seed. `queryPendingActionStatus(actionId)` reads the persisted `status`+`resultJson`;
  `queryExecutionAudit(dedupeKey)` reads the durable recovery `AuditLog` row (typed `ExecutionAuditRow`).

## Constraints
- **Never matches vitest.** Every file avoids `.test.`/`.spec.` (the entry is `.e2e.ts`), so
  `pnpm test` never picks it up. Run it explicitly: `pnpm exec tsx tests/e2e/acceptance.e2e.ts`.
- **Type-checked.** These files ARE compiled by `tsc --noEmit` (tsconfig `include: **/*.ts`) → must
  stay at 0 errors even though vitest transpiles without type-checking.
- **Never fake a pass.** A journey that cannot be automated in-browser emits a `SKIP` + concrete
  reason (or an honest `FAIL`); it never asserts success from an API response alone, and it never
  fabricates a plan badge it did not genuinely read from the DOM.
- **Always tear down.** One idempotent `cleanup()` (wired to `process.on('exit' | 'SIGINT' |
  'SIGTERM' | 'uncaughtException' | 'unhandledRejection')`) kills the dev server's whole process tree
  and closes the browser on success, failure AND unexpected errors. Never leave `next dev` listening.
- **Isolation.** A FRESH browser context per journey isolates locale and developer-mode preferences.
  Every context uses the configured single demo owner and its canonical database session;
  cookies do not select different banking identities. The database is reset between journeys.
- **RENDERED DOM is PRIMARY; DB/ledger is SECONDARY.** Money journeys keep their primary evidence on
  the DOM (assistant narration / plan badges) and add a real read-route cross-check.
- Wait on real DOM conditions, never fixed sleeps; keep generous timeouts for Next dev cold compile.

## Coverage gaps (flows with NO real-browser journey)
New journeys must be registered in `acceptance.e2e.ts#JOURNEYS` (a-transfer-confirm, b-transfer-mfa,
c-plan-pause-resume, d-plan-cancel, e-refresh-action-recovery, f-wedge-refresh-recover,
g-manual-handoff, h-investment-flow, i-anomaly-detection, j-circuit-breaker-lock).
None currently: the three former gaps now EACH have a real-browser journey —
Investment 申购/赎回 + cash-flow row (journey `h`), Anomaly detection (journey `i`),
Circuit-breaker lock/unlock (journey `j`). Their vitest owners remain the primary
unit/scenario coverage: `tests/scenarios/test-09-investment-mfa.test.ts` (+
`tests/unit/banking-sdk/investment*.test.ts`), `tests/scenarios/test-07-anomaly.test.ts` (+
`tests/unit/banking-sdk/anomaly.test.ts`), `tests/scenarios/test-10-circuit-breaker.test.ts`
(+ `tests/app/security-workflow-http.test.ts`).

## Prerequisites (in order, in a fresh worktree)
1. `pnpm install`
- No manual `prisma generate` step: `resetDemoDatabase()` GENERATES the Prisma Client itself when it is
  missing or unusable (and self-heals a partially-provisioned `node_modules`), so a clean `pnpm install`-only
  checkout is sufficient (see "Isolated E2E database").
- A **free port** is chosen at runtime. **System Chrome** is used (Chrome first, Edge fallback;
  `E2E_BROWSER_PATH` overrides detection). **No `playwright install` / browser download** — headless
  Chrome is launched via `chromium.launch({ executablePath, headless: true })`.
- The isolated E2E DB is provisioned by the harness itself (`resetDemoDatabase()`), so no manual
  `db push`/`db:seed` step is needed. `.env` provides `LLM_MODE=mock`.

## How to run
```
pnpm exec tsx tests/e2e/acceptance.e2e.ts
```
One line per journey; the process exits non-zero when any journey FAILs.

## Isolated E2E database
The run uses its OWN SQLite DB (`prisma/e2e.db`) and NEVER touches the shared `prisma/dev.db`.
- `useIsolatedDatabase()` sets `process.env.DATABASE_URL = E2E_DB_URL`, where `E2E_DB_URL` is
  `file:` + the ABSOLUTE path to `prisma/e2e.db` with FORWARD SLASHES
  (`prisma` requires `/` inside a `file:` URL; a Windows `C:\…` backslash URL is rejected) —
  e.g. `file:D:/…/prisma/e2e.db`. `lib/db/client.ts` reads `process.env.DATABASE_URL` first, and Next
  dev does NOT override an already-set `process.env` value with `.env`, so everything the harness
  spawns is isolated.
- The SAME `DATABASE_URL` is passed to BOTH the provisioning CLIs (`runCliStep`) AND the spawned
  dev server (`startDevServer`).
- `resetDemoDatabase()` runs BEFORE the dev server boots (no open connection ⇒ no Windows SQLite
  file-lock). It first ensures a GENERATED, USABLE Prisma Client, then (per attempt) provisions the
  schema + seed through the shared provisioning helper also used by the Vitest setup
  (`../helpers/prisma-cli.ts#provisionSchemaLadder`), which DELETES `e2e.db` + its
  `-wal`/`-shm`/`-journal` sidecars (missing files are fine) before the plain push:
  1. **Client bootstrap / self-heal** (`ensurePrismaClientGenerated`, once per attempt): checks
     `lib/db/generated/client.ts` and `internal/class.ts`. The generated inline schema must match the
     current schema's significant tokens. A separate `tsx` process constructs the application
     `createDatabaseClient('file::memory:')` factory and disconnects it, verifying the actual adapter
     without touching persistent data. Missing, stale or unusable output triggers `prisma generate`.
     The `prisma-client` generator's public facade is `lib/db/prisma.ts`; consumers do not import a
     generated `node_modules/.prisma` client or use a bare constructor.
  2. **Schema and data**: remove the isolated database and sidecars → `prisma db push` →
     `probeDatabaseUsable()` → seed. Prisma 7 does not generate the client during `db push`.
     The harness uses one plain-push rung; it does not request a redundant CLI reset.
  CLI configuration comes from `prisma.config.ts`, including schema location, the normalized
  datasource URL and the seed command. CLI and runtime share `lib/db/url.ts`; runtime clients use the
  `@prisma/adapter-better-sqlite3` factory with exact `bigint` integers and Unix-millisecond dates.
- **Self-diagnosing CLI steps.** `runCliStep`/`runCliStepCaptured` decide success by the **EXIT CODE**
  and, on failure, preserve the
  COMPLETE labelled stdout+stderr — the TAIL is ALWAYS preserved (an output over `CLI_OUTPUT_CAP` = 16 KB
  elides only the MIDDLE), so the schema engine's real reason (often the last stderr line) is never hidden
  by truncation — plus any spawn `error` (message + code). When EVERY ladder rung fails
  (`provisionSchemaLadder`) the thrown message embeds EACH rung's un-truncated output PLUS environment
  diagnostics (resolved `DATABASE_URL`, cwd, project-local Prisma CLI path, a `prisma -v` version/engine
  summary, `node_modules/@prisma/engines/schema-engine*` presence). The whole attempt is retried
  `attempts` times (default 2) with a short backoff — SQLite on Windows is occasionally lock-prone.
- CLIs are invoked like the dev server: project-local binaries (`REPO_ROOT/node_modules/...` launched
  with `process.execPath`), else `pnpm exec` on the supported shell.
- `E2E_SKIP_DB_RESET=1` keeps the current DB (e.g. to inspect post-run data) — the journeys then
  require a freshly seeded DB.
- WHY a reset every run: money journeys are tiered from the FROZEN demo day's accumulated outgoing
  transfers (`demoNow()` = 2026-09-25 12:00), so without a reset a second run would start with the
  prior run's executed transfers already inside the day and the YELLOW-transfer journeys would
  escalate to RED.
- NOTE: `prisma/dev.db` untouched is guaranteed by construction (never referenced). The sidecars
  `prisma/e2e.db-wal`/`-shm` are git-ignored (see `.gitignore`: `prisma/*.db-wal`, `prisma/*.db-shm`,
  plus `prisma/*.db` / `prisma/*.db-journal`).

## Journeys (each asserts on RENDERED DOM; money journeys add a DB/ledger cross-check)
- **natural-conversation-and-financial-boundary** starts an incomplete transfer draft, then asks about
  funding, small talk and scheduled tasks. Each answer must be nonempty natural prose without recovery
  warnings or model protocol JSON, and must create no authorization or plan. A later bare amount must
  not resume the abandoned draft. Reload preserves the replies; a complete transfer request still
  creates the expected confirmation, with balances, ledger, cards and schedules unchanged.
- **a-transfer-confirm** (YELLOW transfer ≤¥1000): `给张伟转200元` → ConfirmationCard (`确认`/`取消`)
  → click `确认` → assistant text `转账处理结果：…`. SECONDARY: CHECKING balance drops by ¥200 AND a
  new `-200 DEBIT` ledger row to 张伟 appears (`GET /api/dashboard` + `GET /api/bills`).
- **b-transfer-mfa** (RED transfer >¥1000) — two legs in fresh contexts:
  - leg 1 (correct `123456`) → success narration; balance −¥2000 + new `-2000 DEBIT` ledger row.
  - leg 2 (wrong `000000`) → `role=status` `验证失败，已尝试 1 次`; MFA card STAYS; NO success
    narration; balance + ledger UNCHANGED (no transfer occurred).
- **c-plan-pause-resume** (GENUINE pause→resume on a GATED plan): gated plan
  `如果我这个月消费超过2000，就把信用卡娱乐限额调整到1500元` parks at `等待确认` (a NON-terminal
  state, so `PlanCard` renders a REAL `暂停` control). The journey waits for the node timeline
  (`查询消费情况` = `成功`, `调整` = `待确认`), then ACTUALLY clicks `暂停` → badge `已暂停` (and `继续`
  appears, `暂停` disappears) → asserts during the pause the parked node stays `待确认` and the 娱乐
  card limit is unchanged → clicks `继续` → the plan returns to `等待确认`; completed node
  `查询消费情况` remains `成功` (NOT re-run) and the remaining node `调整` re-parks at `待确认`.
- **d-plan-cancel** (gated plan; cancelled plan moves NO money): gated plan → `等待确认` →
  plan-card `取消` → badge `已取消`. THEN attempts the OLD confirmation entry: if a parked
  ConfirmationCard `确认` button is still rendered, it clicks it and asserts the server REJECTS it
  (HTTP 200 `data.ok=false`/`status=cancelled`, or a 4xx error envelope); if the card is gone, it
  proves that via the rendered DOM (button count 0) + `GET /api/actions` (no leaked non-terminal
  action). Either way balance / ledger / 娱乐 limit are UNCHANGED.
- **e-refresh-action-recovery** — two legs, SAME context across reload (the fixed demo workspace persists):
  - leg 1 parks a **STATIC-YELLOW** `set_card_limit` (its tier does not depend on the
    demo day's accumulated transfer total) → same-context reload → ConfirmationCard RESTORED from
    persisted server state (`GET /api/actions`).
  - leg 2 (fresh context) parks a RED transfer → reload → MfaCard RESTORED.
- **f-wedge-refresh-recover** (the PLAIN refresh/navigation recovery surface — the recovery control is
  reached with NO actionId in the URL): opens the fixed workspace with a first GREEN chat turn, snapshots
  balance+ledger, then SEEDS a committed-but-unrecorded standalone transfer straight into the isolated E2E
  DB (debit + DEBIT `Transaction` + committed `ExecutionReceipt` + `PendingAction pa_ewedge_1` at
  `confirmed` with `resultJson=null`). A plain `page.goto('/agent')` must RENDER the inline recovery card with a `恢复执行`
  button; clicking it settles the wedge FROM the committed receipt (never a second debit) and the journey
  asserts on the DOM-reachable read routes + direct DB facts: balance exactly one `−¥200`, exactly ONE new
  `−200 DEBIT`/张伟 ledger row, `PendingAction.status='executed'`, and a durable recovery
  `AuditLog` (`dedupeKey=exec:pa_ewedge_1`) at `success`/`transfer_money` for the owning session.
- **h-investment-flow** (two RED MFA flows in ONE page): `申购稳健理财A 1000元` → MfaCard → `123456`
  → assistant `理财申购结果：`; THEN `赎回稳健理财A` → MfaCard → `123456` → assistant `理财赎回结果：`.
  SECONDARY: `GET /api/bills` shows a `投资`-category DEBIT `认购稳健理财A` AND a CREDIT `赎回` row.
  Because the SETTLED subscribe inline MFA card re-renders in its message once its action settles
  (its duplicate-suppression ends while the next action is not yet active), the redeem leg counts the
  code inputs before the redeem turn and waits for ONE MORE (see Design notes).
- **i-anomaly-detection** (GREEN `detect_anomaly`): `帮我看有没有异常消费` → rendered `AnomalyCard`
  (`异常交易提醒` / `Apple Store` / `-¥6,999.00` / `风险 低`); the assistant does NOT claim
  `未发现可疑交易`. SECONDARY: `GET /api/bills` `anomalies` is exactly the one `tx_anomaly_apple`
  DEBIT row (DEBIT-only, no CREDIT).
- **j-circuit-breaker-lock** (DURABLE per-OWNER lock): reset the account breaker to a known zero state,
  then THREE consecutive wrong MFA codes (`000000`) on a RED transfer (after each, `role=status` shows
  `验证失败，已尝试 N 次`) trip it → security center `已熔断` + `失败 3 / 3 次` + a DB-cross-checked
  `CIRCUIT_BREAKER_TRIPPED` (severity `high`).
  In normal mode `/security` has no reset control. A direct reset request without developer mode
  returns `403` and leaves the lock intact. After enabling developer mode, one code-free reset
  button clears the failed-attempt count and records `SECURITY_RESET` (DOM + DB). The page has no
  password or six-digit code field for this developer action. Payment/card MFA remains separate.
- **multi-card-freeze-audit-history** verifies two independent RED authorizations, one card change
  per accepted code, two successful audit rows, and one completed historical plan before later
  conversation messages both before and after refresh.
- **banking-pages** verifies contact creation, cancelled/confirmed deletion, investment products
  and holdings, and the updated sidebar without a standalone pending-actions entry.

## Coverage notes
- **Covers:** real-browser NL → card → human-decision flows; MFA success + wrong-code rejection;
  TWO RED MFA flows in one page (journey `h`) driving the LIVE (last-rendered) decision card;
  GENUINE plan pause→resume with per-node status badges; plan cancel + rejected stale-confirm;
  no-money-moved assertions (balance + ledger + card limit); refresh rehydration from persisted
  server state; a plain refresh/navigation recovery of a committed-but-unrecorded standalone wedge
  (exactly one debit, `executed` status, durable recovery audit); an anomaly card (journey `i`) and a
  durable circuit-breaker lock/unlock (journey `j`); structured honest reporting; whole-tree teardown.
- **Does NOT cover:** the real LLM (`LLM_MODE=live`); real bank/network; the production build
  (`next build` / `next start`); cross-browser (Chrome only, Edge as fallback and untested);
  visual/a11y regression; load/perf; the security unit + scenario layers (owned by
  `tests/unit` / `tests/scenarios`).

## Design notes (harness mechanics)
- **React-hydration gate.** `gotoAgent` returns only once the SSR composer `<textarea>` is visible
  AND hydrated; `submitChat` re-checks hydration before `fill()`/click, and the reload path re-waits
  via `waitForComposer`. Before hydration the server-rendered `<textarea>` carries NO React
  own-property (`__reactProps$…`/`__reactFiber$…`), so interacting then silently DROPS the click
  (no `POST /api/chat` is issued) and React's hydration resets the `fill()`.
  `waitForComposerHydration` waits on that real DOM condition — never a fixed sleep.
- **Robust dev-server boot.** `bootDevServer()` prefers the direct Next CLI
  (`<process.execPath> <next bin> dev -p <port>`), locating the binary via `resolveNextBin()`, which
  tries the project-local `REPO_ROOT/node_modules/next/dist/bin/next` FIRST and then Node's own
  resolution (`createRequire(import.meta.url).resolve('next/dist/bin/next')`) so a worktree with NO
  local `node_modules` still finds the hoisted/shared `next` (each accepted only when it exists on
  disk). Only when neither resolves does it fall back to
  `cmd.exe /d /s /c "pnpm exec next dev …"` (Windows) / `pnpm exec next dev …` (POSIX) — deliberately NOT Node's
  `shell: true`, which re-serialized args and produced an empty stdout pipe. It waits for BOTH
  `/api/health` AND `/agent` and retries ONCE on a fresh port; when every attempt fails it prints the
  captured dev-server log tail and the entry script FAILs every journey.
- **PlanCard selection.** Each plan appears once in its original assistant message; progress and
  authorization snapshots update that same card. `planCard()` selects the latest matching plan for
  isolated journeys. The multi-card freeze helper additionally asserts a single completed plan
  remains before unrelated later messages after refresh, with no stale pause control or footer copy.
- **Live MFA card selection.** Like the PlanCard, a RED gated tool emits BOTH an `mfa_required` event
  (rendered as the LIVE decision card AFTER the whole message list) AND an inline `mfa` ChatCard in the
  assistant message. `ChatWindow` suppresses the inline duplicate only WHILE that action is active;
  once it SETTLES the inline card re-renders (an `mfa` card carries no status field), so a page can show
  SEVERAL `input[aria-label="验证码"]` elements. `waitForMfaCard(page, timeoutMs, minCount = 1)` waits
  for the count to REACH `minCount` (so a stale card cannot make a naive `count > 0` wait return early),
  and `submitMfa` fills/clicks `.last()` — the LIVE card `ChatWindow` always renders LAST. On a
  single-card page `.last()` === `.first()`. Journey `h` (two RED flows in one page) passes
  `beforeMfaCount + 1` to the redeem leg's `waitForMfaCard`; `clickLastWhenEnabled` exists because the
  general `clickWhenEnabled` is `.first()`-scoped for `submitChat`/`clickConfirm`.
- **Security-center breaker control (journey `j`).** `ResetBreakerButton` is rendered only in
  developer mode and submits a code-free reset request. `POST /api/security/reset` checks the mode
  preference and rejects normal-mode requests with `403`. The journey verifies hidden controls,
  retained lock after rejection, developer enable/reset, and the durable reset event.
- **Per-node timeline.** `planNodeRows()` scopes to `ol.space-y-3 > li` inside the live card (avoiding
  the SECOND copy of every node name in the card's 依赖关系 dependency list), reading the node name
  (`span.text-sm.font-medium.text-banking-deep`) + its status `span.rounded-full` badge.
- **Transfer ledger `merchant`.** A transfer row's `merchant` is the plain recipient name
  (`张伟`); the merchant JSDoc mentions `'转账给'+name`, but the runtime value is the plain name —
  assertions use `.includes(RECIPIENT_NAME)`.
- **Standalone-wedge seeding (journey `f`).** The recovery surface must be reachable by PLAIN
  navigation, so the journey NEVER passes the actionId in the URL: it opens the fixed workspace with a first
  GREEN chat turn, seeds the committed-but-unrecorded rows directly into the isolated E2E DB
  (`seedStandaloneWedge`, ONE transaction, no wipe/re-seed), then does a plain
  `page.goto('/agent')` and clicks the rendered inline `恢复执行` control.

## Known Limitations
- **Plan DAG has no observable "downstream node ran after resume".** The gated mock plan's `setlimit`
  node is its LAST node, so after resume the only remaining node re-executes and RE-PARKS at
  `等待确认`; that re-entry to `等待确认` is the observable proof that the remaining node ran. A
  directly observable "a later node executed after resume" would require a GREEN node AFTER
  `setlimit` in `agent/providers/mock-responder.ts#handlePlan` (a sibling outside `tests/e2e/`) —
  reported upward.
- **No real browser ⇒ SKIP, not FAIL.** When neither Chrome nor Edge is found (and `E2E_BROWSER_PATH`
  is unset) every journey emits `SKIP` with the reason; the run does not fail.

## Live-LLM acceptance harness (`./live-acceptance.e2e.ts`)
A SECOND, independent real-browser harness that drives the REAL `next dev` app against the REAL
DeepSeek API (`LLM_MODE=live`) instead of the scripted mock — same real Chrome + real route handlers,
only the LLM is live.
- Run: `pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`; subset via `LIVE_SCENARIOS=1,3` (ids `0,1,2,2p,3,4,5,6,7,8,9,10,11`; selecting `2` also pulls `2p`).
- Scenario `9` reuses the multi-card freeze helper with live DeepSeek: two independent MFA gates,
  audit visibility and historical plan ordering across an unrelated message and refresh.
- Scenario `10` checks page-only card creation/deletion and rejects those capabilities in live chat.
- Scenario `11` verifies natural conversation, capability explanations, draft isolation and the later
  financial confirmation boundary using the same assertions as the mock journey.
- Own isolated DB `prisma/live-acceptance.db` (never `e2e.db`/`dev.db`/`test.db`); `configureLiveEnv()` sets `DATABASE_URL`.
- Uses the Next.js environment loader before booting; it does not directly read or parse `.env.local`,
  and configuration values are never printed. Spawned processes inherit the configured environment.
- `LIVE_FORCE_MODEL` is an OPT-IN model override; by DEFAULT it does NOT override, so `agent/providers/provider-live.ts#resolveLiveModel` resolves the PROVIDED `.env.local` id for real.
- `PARK_ATTEMPTS` retry/nudge logic for the flaky park; `awaitSessionCookie()` bounded wait for the `banking_session` cookie; one idempotent `cleanup()` stops the ACTIVE dev server (incl. the scenario-7 reboot), wired to exit/signals.
- TASK-A evidence tooling: `persistedRecipientCalls()` parses every `AgentSession.stateJson` and prints each `transfer_money`/`search_contact` `toolCall` arg object VERBATIM; `LIVE_S2_PROMPT`/`LIVE_S3_PROMPT` override the two transfer prompts.
- Current live outcome (see `./LIVE-ACCEPTANCE-REPORT.md`): a clean FULL run reached
  `== 汇总：PASS 8 ｜ FAIL 0 ｜ SKIP 0 ==` (`EXIT=0`). **Every one of the 8 scenarios PASSES live**
  (1, 2, 2p — BOTH phone legs — 3, 4, 5, 6, 7), cross-checked against the DB/API. The formerly-failing
  S2p RAW-phone leg (`13900000002`) now PASSES: the APP read path `lib/db/repositories/contact.ts#searchContacts`
  is mask-aware via `lib/phone.ts#maskAwarePhoneMatch`, so a raw number resolves to the MASKED seed phone `139****0002`.
- The `next dev` boot is now first-attempt reliable even in a worktree with NO local `node_modules`,
  because `helpers.ts#resolveNextBin()` falls back to Node's own module resolution
  (`createRequire(import.meta.url).resolve('next/dist/bin/next')`) so the reliable direct-binary path
  is taken before the package-manager fallback path.
- **Live-model narration flake (model nondeterminism, NOT infrastructure / app logic):** the LIVE
  model occasionally replies to a money prompt with a confirmation *question* and never calls the
  gated tool that turn, so no confirmation/MFA card appears and the card wait times out
  (`/api/actions=[]`, only `search_contact` persisted). It is not deterministic — the same prompt
  parks correctly on other runs — so re-running the affected scenario (or the full suite) confirms it
  green. Only scenario 7 has nudge/retry (`PARK_ATTEMPTS`).

## Routing Table
- `./acceptance.e2e.ts` → the single real-browser entry point (isolated DB → reset → boot → readiness → 23 registered journeys → structured report → non-zero exit on FAIL)
- `./activity.e2e-helper.ts` → public business projection, developer-only audit HTML/RSC/API, preference persistence and browser isolation, disable navigation and mobile layout
- `./chat-history.e2e-helper.ts` → latest twenty complete messages, older-page retry and scroll anchors, preserved drafts/preferences, new-message indicator, bounded refresh, browser sharing and reset fencing against delayed history responses
- `./card-freeze.e2e-helper.ts` → two independently verified card freezes in ordinary business history, explicitly enabled developer audits, and completed-plan history ordering before/after refresh; reused by live scenario 9
- `./banking-pages.e2e-helper.ts` → contact creation/deletion, investment product/holding displays and grouped navigation
- `./card-management.e2e-helper.ts` → page-only card record changes, separate MFA, refresh recovery, repeat verification, preserved ledger/audit, mobile layout and Agent exclusion; reused by live scenario 10
- `./conversation.e2e-helper.ts` → natural prose, draft isolation, signed input refusal, persistent recall and subscription analysis; reused by live scenarios 11 and 12
- `./live-acceptance.e2e.ts` → REAL-browser + REAL-LLM (`LLM_MODE=live`) acceptance harness against DeepSeek; own isolated DB `prisma/live-acceptance.db`; `LIVE_SCENARIOS` subset; embeds the TASK-A persisted-tool-arg evidence dump (`persistedRecipientCalls`)
- `./LIVE-ACCEPTANCE-REPORT.md` → current-state report of the live runs (a clean FULL run — `PASS 8 ｜ FAIL 0 ｜ SKIP 0` — with all 8 scenarios PASS live including the formerly-failing S2p raw-phone leg; plus the honest live-model narration-flake blocker)
- `./helpers.ts` → shared harness (isolated E2E DB + reset, free port, dev-server boot/teardown, readiness poll, hydration gate, browser factory, `withPage`, DOM selectors/interactions, plan card + per-node timeline, read-model HTTP helpers, wedge fixtures + `seedStandaloneWedge`/direct-DB fact queries (`queryPendingActionStatus`/`queryExecutionAudit`), reporter, fail-fast navigation)
- `./screenshots/` → git-ignored failure screenshots
- `../app` → HTTP route-handler specs (the in-process acceptance layer this harness complements) (sibling — read-only)
- `../setup.ts` + `../helpers` → vitest global setup + fixtures (untouched by this harness) (sibling — read-only)
- `../../prisma/seed.ts` → the canonical demo dataset the E2E DB is seeded from (sibling — read-only)
- `../../agent/providers/mock-responder.ts` → the scripted mock plan/transfer responses the journeys trigger (sibling — read-only)
