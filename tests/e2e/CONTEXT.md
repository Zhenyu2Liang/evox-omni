# tests/e2e — Real-Browser End-to-End Acceptance Harness

## Intent
The top of the test pyramid: prove the AI Banking Agent demo works through a **REAL browser**
driving the **REAL Next.js app** — not just in-process route handlers. It boots the actual
`next dev` server on a free port, launches the machine's real headless **Chrome** via
`playwright-core`, types natural-language requests into the real `/agent` composer, and asserts on
**RENDERED DOM** (cards, buttons, badges, assistant text). Only the LLM is scripted
(`LLM_MODE=mock`); the app, route handlers, security gateway, banking SDK and SQLite DB are real.

This node is **self-contained** — it does not import `tests/app/*` or any `@/` alias (relative
imports + node built-ins only, to avoid tsx/tsconfig path surprises).

## API Surface
- `acceptance.e2e.ts` — the SINGLE entry point. Resets the demo DB → boots the app → waits for
  readiness → launches Chrome → runs the journeys → prints exactly one
  `PASS|FAIL|SKIP <journey> — <evidence>` line per journey → exits non-zero iff ANY journey FAILED
  (a SKIP does not fail the run).
- `helpers.ts` — shared harness: `pickFreePort`, `bootDevServer` (project-local Next CLI, readiness
  gated on `/api/health` + `/agent`, one retry on a fresh port) with `startDevServer`/
  `killProcessTree` (whole-tree teardown), `resetDemoDatabase` (see "Deterministic demo DB reset"),
  `resolveBrowserExecutable`/`launchBrowser`, `withPage` (fresh isolated context + failure screenshot
  + `pageerror` capture), the hydration gate (`waitForComposerHydration`), DOM selectors +
  interactions (`submitChat`, `clickConfirm`, `submitMfa`, `waitForPlanStatus`, `clickPlanControl`,
  `planCard`, …), the structured `createReporter`, and the fail-fast `gotoAgent`/`readSsrPageError`.
- `screenshots/` — git-ignored failure screenshots (`.gitignore` ignores everything but itself).
- `CONTEXT.md` — this file.

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
- Wait on real DOM conditions, never fixed sleeps; keep generous timeouts for Next dev cold compile.

## Prerequisites (in order, in a fresh worktree)
1. `npm install`
2. `npx prisma generate`
3. `npx prisma db push`
4. `npm run db:seed`
- A **free port** is chosen at runtime. **System Chrome** is used (Chrome first, Edge fallback;
  `E2E_BROWSER_PATH` overrides detection). **No `playwright install` / browser download** — headless
  Chrome is launched via `chromium.launch({ executablePath, headless: true })`.
- `.env` provides `LLM_MODE=mock` (deterministic scripted model) and the demo SQLite URL.

## How to run
```
npx tsx tests/e2e/acceptance.e2e.ts
```
One line per journey; the process exits non-zero when any journey FAILs.

## Deterministic demo DB reset
`resetDemoDatabase()` runs BEFORE the dev server boots (no open connection ⇒ no Windows SQLite
file-lock) so every run starts from the canonical seeded state — the money journeys are tiered from
the FROZEN demo day's accumulated outgoing transfers (`demoNow()` = 2026-09-25 12:00), so without a
reset a second run would start with the previous run's executed transfers already inside the day and
the YELLOW-transfer journeys would escalate to RED.

Recipe: delete `prisma/dev.db` + its `-wal`/`-shm`/`-journal` sidecars (missing files are fine) →
`prisma db push --skip-generate` (creates a fresh schema) → seed via `tsx prisma/seed.ts`. This
**deliberately AVOIDS `prisma db push --force-reset`**: on Windows that path was seen to leave
`prisma/dev.db` as a 0-byte image and then fail with `Error code 11: database disk image is
malformed`, which aborted the seed and failed all five journeys at the infrastructure stage.

CLIs are invoked like the dev server: prefer the project-local binaries
(`REPO_ROOT/node_modules/...` launched with `process.execPath`, mirroring `resolveNextBin()`), else
fall back to `cmd.exe /d /s /c "npx …"` on Windows / a plain command on POSIX. The whole attempt is
retried ONCE with a short backoff (SQLite on Windows is occasionally lock-prone), each step's combined
stdout+stderr is captured into the thrown error, and success is decided by the **EXIT CODE** (the
deprecated `package.json#prisma` warning lines are harmless).
`E2E_SKIP_DB_RESET=1` keeps the current DB (e.g. to inspect post-run data) — the journeys then
require a freshly seeded DB.

**Env propagation (how a DB URL reaches the children).** The harness (`npx tsx tests/e2e/acceptance.e2e.ts`)
does NOT load `.env` (tsx has no dotenv shim). The spawned `next dev` is launched with
`env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }` (`startDevServer`), and then Next.js itself loads
`.env` at boot (Next's env loader does not override an already-set var). The Prisma/tsx CLI children
(`runCliStep` -> `spawnSync` with NO `env` key) inherit the harness's `process.env` unchanged. So to point
BOTH the CLIs and the dev server at an isolated DB, set `process.env.DATABASE_URL` (an ABSOLUTE `file:`
URL -- a relative `file:./...` resolves against the Prisma schema dir) BEFORE `resetDemoDatabase()` and
`bootDevServer()`. Current DB file: `prisma/dev.db` (+ `-wal`/`-shm`/`-journal`, `DEV_DB_FILES`).

## Journeys (each asserts on RENDERED DOM)
- **a-transfer-confirm** (YELLOW transfer ≤¥1000): `给张伟转200元` → ConfirmationCard (`确认`/`取消`)
  → click `确认` → assistant text `转账处理结果：…`.
- **b-transfer-mfa** (RED transfer >¥1000) — two legs in fresh contexts: correct code `123456` →
  success narration; wrong code `000000` → `role=status` `验证失败，已尝试 1 次`, MFA card STAYS, and
  NO success narration (the transfer did not occur).
- **c-plan-pause-resume**: NON-gated plan `帮我规划一下：先查一下我的余额，然后汇总` (`balance` GREEN
  `get_balance` → `summarize` note; no node is risk-gated). `runSubmitPlan` AWAITS the executor and
  `POST /api/chat` delivers its SSE frames only after the turn settles, so the PlanCard first renders
  on an ALREADY-terminal state → badge `已完成` with NO `暂停` control. The journey asserts exactly
  that rendered state; it only drives `暂停`→`继续` if it ever catches the card mid-run with a `暂停`
  control present. Completion is NEVER fabricated.
- **d-plan-cancel**: gated plan `如果我这个月消费超过2000，就把信用卡娱乐限额调整到1500元` →
  `等待确认` → plan-card `取消` → badge `已取消`.
- **e-refresh-action-recovery** — two legs: park a **STATIC-YELLOW** `freeze_card` (`冻结我的信用卡`,
  so the tier does not depend on the demo day's accumulated transfer total) → same-context reload →
  ConfirmationCard RESTORED from persisted server state; park a RED transfer → reload → MfaCard
  RESTORED.

## Coverage notes
- **Covers:** real-browser NL → card → human-decision flows; MFA success + wrong-code rejection;
  plan terminal state + cancel; refresh rehydration from persisted server state; structured honest
  reporting; whole-tree teardown.
- **Does NOT cover:** the real LLM (`LLM_MODE=live`); real bank/network; the production build
  (`next build` / `next start`); cross-browser (Chrome only, Edge as fallback and untested);
  visual/a11y regression; load/perf; the security unit + scenario layers (owned by
  `tests/unit` / `tests/scenarios`).

## Design notes (harness mechanics)
- **React-hydration gate.** `gotoAgent` returns only once the SSR composer `<textarea>` is visible
  AND hydrated; `submitChat` re-checks hydration before `fill()`/click, and the reload path re-waits
  via `waitForComposer`. Before hydration the server-rendered `<textarea>` carries NO React
  own-property (`__reactProps$…`/`__reactFiber$…`), so interacting then silently DROPS the click
  (no `POST /api/chat` is issued) and React's hydration resets the `fill()`. `waitForComposerHydration`
  waits on that real DOM condition — never a fixed sleep.
- **Robust dev-server boot.** `bootDevServer()` prefers the project-local Next CLI
  (`<process.execPath> node_modules/next/dist/bin/next dev -p <port>`) and falls back to
  `cmd.exe /d /s /c "npx next dev …"` (Windows) / `npx next dev …` (POSIX) — deliberately NOT Node's
  `shell: true`, which re-serialized args and produced an empty stdout pipe. It waits for BOTH
  `/api/health` AND `/agent` (`waitForAppReady`) and retries ONCE on a fresh port; when every attempt
  fails it prints the captured dev-server log tail and the entry script FAILs every journey.
- **Live PlanCard selection.** A plan turn renders the DAG snapshot TWICE — inline in the assistant
  bubble (frozen; nothing rewrites `message.cards`) and as the live `stream.activePlan` card after the
  messages. `planCard()` therefore selects the LAST match (`PLAN_CARD_XPATH … [last()]`), so
  plan-control outcomes are read from the app-authoritative live card.

## Known Limitations
- **`c-plan-pause-resume` has no pausable window in mock mode.** Because the plan executes
  synchronously inside the chat turn, the card's first render is already `已完成` and offers no
  `暂停` control, so a genuine `暂停`→`继续` cycle cannot be observed. The journey reports the
  genuinely rendered badge (or the pause path when it wins the race) and never fabricates `已完成`.
- **No real browser ⇒ SKIP, not FAIL.** When neither Chrome nor Edge is found (and `E2E_BROWSER_PATH`
  is unset) every journey emits `SKIP` with the reason; the run does not fail.

## Routing Table
- `./acceptance.e2e.ts` → the single real-browser entry point (DB reset → boot → readiness → journeys → structured report → non-zero exit on FAIL)
- `./helpers.ts` → shared harness (demo DB reset, free port, dev-server boot/teardown, readiness poll, hydration gate, browser factory, `withPage`, DOM selectors/interactions, plan card, reporter, fail-fast navigation)
- `./screenshots/` → git-ignored failure screenshots
- `../app` → HTTP route-handler specs (the in-process acceptance layer this harness complements) (sibling — read-only)
- `../setup.ts` + `../helpers` → vitest global setup + fixtures (untouched by this harness) (sibling — read-only)
