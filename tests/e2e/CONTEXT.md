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
  seed → boots the app → waits for readiness → launches Chrome → runs the 5 journeys → prints
  exactly one `PASS|FAIL|SKIP <journey> — <evidence>` line per journey → exits non-zero iff ANY
  journey FAILED (a SKIP does not fail the run).
- `helpers.ts` — shared harness (details below).
- `screenshots/` — git-ignored failure screenshots (`.gitignore` ignores everything but itself).
- `CONTEXT.md` — this file.

Harness helpers (`helpers.ts`):
- Boot/teardown: `pickFreePort`, `startDevServer`, `waitForHealth`, `waitForAppReady`,
  `bootDevServer` (project-local Next CLI, readiness gated on `/api/health` + `/agent`, one retry on
  a fresh port), `killProcessTree` (whole-tree teardown).
- **Isolated DB**: `E2E_DB_URL` (absolute `file:` URL to `prisma/e2e.db`), `useIsolatedDatabase()`
  (sets `process.env.DATABASE_URL`), `resetDemoDatabase()` (see "Isolated E2E database").
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

## Constraints
- **Never matches vitest.** Every file avoids `.test.`/`.spec.` (the entry is `.e2e.ts`), so
  `npm run test` never picks it up. Run it explicitly: `npx tsx tests/e2e/acceptance.e2e.ts`.
- **Type-checked.** These files ARE compiled by `tsc --noEmit` (tsconfig `include: **/*.ts`) → must
  stay at 0 errors even though vitest transpiles without type-checking.
- **Never fake a pass.** A journey that cannot be automated in-browser emits a `SKIP` + concrete
  reason (or an honest `FAIL`); it never asserts success from an API response alone, and it never
  fabricates a plan badge it did not genuinely read from the DOM.
- **Always tear down.** One idempotent `cleanup()` (wired to `process.on('exit' | 'SIGINT' |
  'SIGTERM' | 'uncaughtException' | 'unhandledRejection')`) kills the dev server's whole process tree
  and closes the browser on success, failure AND unexpected errors. Never leave `next dev` listening.
- **Isolation.** A FRESH browser context (fresh cookies) per journey. Identity is the HttpOnly
  `banking_session` cookie, so the refresh-recovery journey reuses the SAME context across reload.
- **RENDERED DOM is PRIMARY; DB/ledger is SECONDARY.** Money journeys keep their primary evidence on
  the DOM (assistant narration / plan badges) and add a real read-route cross-check.
- Wait on real DOM conditions, never fixed sleeps; keep generous timeouts for Next dev cold compile.

## Prerequisites (in order, in a fresh worktree)
1. `npm install`
2. `npx prisma generate`
- A **free port** is chosen at runtime. **System Chrome** is used (Chrome first, Edge fallback;
  `E2E_BROWSER_PATH` overrides detection). **No `playwright install` / browser download** — headless
  Chrome is launched via `chromium.launch({ executablePath, headless: true })`.
- The isolated E2E DB is provisioned by the harness itself (`resetDemoDatabase()`), so no manual
  `db push`/`db:seed` step is needed. `.env` provides `LLM_MODE=mock`.

## How to run
```
npx tsx tests/e2e/acceptance.e2e.ts
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
  file-lock). Recipe: delete `e2e.db` + its `-wal`/`-shm`/`-journal` sidecars (missing files are
  fine) → `prisma db push --skip-generate` → seed via `tsx prisma/seed.ts`. This **deliberately
  AVOIDS `prisma db push --force-reset`**: on Windows that path was seen to leave the DB file as a
  0-byte image and then fail with `Error code 11: database disk image is malformed`, aborting the
  seed and failing all journeys. The whole attempt is retried ONCE with a short backoff (SQLite on
  Windows is occasionally lock-prone); each step's combined stdout+stderr is captured into the
  thrown error and success is decided by the **EXIT CODE** (the deprecated `package.json#prisma`
  warning lines are harmless).
- CLIs are invoked like the dev server: project-local binaries (`REPO_ROOT/node_modules/...` launched
  with `process.execPath`), else `cmd.exe /d /s /c "npx …"` on Windows / a plain command on POSIX.
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
- **e-refresh-action-recovery** — two legs, SAME context across reload (the HttpOnly cookie persists):
  - leg 1 parks a **STATIC-YELLOW** `freeze_card` (`冻结我的信用卡`, so its tier does not depend on the
    demo day's accumulated transfer total) → same-context reload → ConfirmationCard RESTORED from
    persisted server state (`GET /api/actions`).
  - leg 2 (fresh context) parks a RED transfer → reload → MfaCard RESTORED.

## Coverage notes
- **Covers:** real-browser NL → card → human-decision flows; MFA success + wrong-code rejection;
  GENUINE plan pause→resume with per-node status badges; plan cancel + rejected stale-confirm;
  no-money-moved assertions (balance + ledger + card limit); refresh rehydration from persisted
  server state; structured honest reporting; whole-tree teardown.
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
- **Robust dev-server boot.** `bootDevServer()` prefers the project-local Next CLI
  (`<process.execPath> node_modules/next/dist/bin/next dev -p <port>`) and falls back to
  `cmd.exe /d /s /c "npx next dev …"` (Windows) / `npx next dev …` (POSIX) — deliberately NOT Node's
  `shell: true`, which re-serialized args and produced an empty stdout pipe. It waits for BOTH
  `/api/health` AND `/agent` and retries ONCE on a fresh port; when every attempt fails it prints the
  captured dev-server log tail and the entry script FAILs every journey.
- **Live PlanCard selection.** A plan turn renders the DAG snapshot TWICE — inline in the assistant
  bubble (frozen; nothing rewrites `message.cards`) and as the live `stream.activePlan` card after the
  messages. `planCard()` therefore selects the LAST match (`PLAN_CARD_XPATH … [last()]`), so
  plan-control outcomes are read from the app-authoritative live card.
- **Per-node timeline.** `planNodeRows()` scopes to `ol.space-y-3 > li` inside the live card (avoiding
  the SECOND copy of every node name in the card's 依赖关系 dependency list), reading the node name
  (`span.text-sm.font-medium.text-banking-deep`) + its status `span.rounded-full` badge.
- **Transfer ledger `merchant`.** A transfer row's `merchant` is the plain recipient name
  (`张伟`); the merchant JSDoc mentions `'转账给'+name`, but the runtime value is the plain name —
  assertions use `.includes(RECIPIENT_NAME)`.

## Known Limitations
- **Plan DAG has no observable "downstream node ran after resume".** The gated mock plan's `setlimit`
  node is its LAST node, so after resume the only remaining node re-executes and RE-PARKS at
  `等待确认`; that re-entry to `等待确认` is the observable proof that the remaining node ran. A
  directly observable "a later node executed after resume" would require a GREEN node AFTER
  `setlimit` in `agent/providers/mock-responder.ts#handlePlan` (a sibling outside `tests/e2e/`) —
  reported upward.
- **No real browser ⇒ SKIP, not FAIL.** When neither Chrome nor Edge is found (and `E2E_BROWSER_PATH`
  is unset) every journey emits `SKIP` with the reason; the run does not fail.

## Routing Table
- `./acceptance.e2e.ts` → the single real-browser entry point (isolated DB → reset → boot → readiness → 5 journeys → structured report → non-zero exit on FAIL)
- `./helpers.ts` → shared harness (isolated E2E DB + reset, free port, dev-server boot/teardown, readiness poll, hydration gate, browser factory, `withPage`, DOM selectors/interactions, plan card + per-node timeline, read-model HTTP helpers, reporter, fail-fast navigation)
- `./screenshots/` → git-ignored failure screenshots
- `../app` → HTTP route-handler specs (the in-process acceptance layer this harness complements) (sibling — read-only)
- `../setup.ts` + `../helpers` → vitest global setup + fixtures (untouched by this harness) (sibling — read-only)
- `../../prisma/seed.ts` → the canonical demo dataset the E2E DB is seeded from (sibling — read-only)
- `../../agent/providers/mock-responder.ts` → the scripted mock plan/transfer responses the journeys trigger (sibling — read-only)
