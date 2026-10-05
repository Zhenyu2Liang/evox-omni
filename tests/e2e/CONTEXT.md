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
- `acceptance.e2e.ts` — the SINGLE entry point. Boots the app → waits for readiness → launches
  Chrome → runs the journeys → prints exactly one `PASS|FAIL|SKIP <journey> — <evidence>` line per
  journey → exits non-zero iff ANY journey FAILED (a SKIP does not fail the run).
- `helpers.ts` — shared harness: `pickFreePort`, `startDevServer`/`killProcessTree` (whole-path
  teardown; boots `cmd.exe /d /s /c "npx next dev -p <port>"` detached — deliberately NOT
  `shell:true`, which produced an empty stdout pipe here), `waitForHealth`, `resolveBrowserExecutable`/
  `launchBrowser`, `withPage` (fresh isolated context + failure screenshot + `pageerror` capture), DOM
  selectors + interactions (`submitChat`, `clickConfirm`, `submitMfa`, `waitForPlanStatus`,
  `clickPlanControl`, …), the structured `createReporter`, and the fail-fast `gotoAgent`/
  `readSsrPageError`.
- `screenshots/` — git-ignored failure screenshots (`.gitignore` ignores everything but itself).
- `CONTEXT.md` — this file.

## Constraints
- **Never matches vitest.** Every file avoids `.test.`/`.spec.` (the entry is `.e2e.ts`), so
  `npm run test` never picks it up. Run it explicitly: `npx tsx tests/e2e/acceptance.e2e.ts`.
- **Type-checked.** These files ARE compiled by `tsc --noEmit` (tsconfig `include: **/*.ts`) → must
  stay at 0 errors even though vitest transpiles without type-checking.
- **Never fake a pass.** A journey that cannot be automated in-browser emits a `SKIP` + concrete
  reason (or an honest `FAIL`); it never asserts success from an API response alone.
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

## Journeys (each asserts on RENDERED DOM)
- **a-transfer-confirm** (YELLOW transfer ≤¥1000): `给张伟转200元` → ConfirmationCard (`确认`/`取消`)
  → click `确认` → assistant text `转账处理结果：…`.
- **b-transfer-mfa** (RED transfer >¥1000) — two legs in fresh contexts: correct code `123456` →
  success narration; wrong code `000000` → `role=status` `验证失败，已尝试 1 次`, MFA card STAYS, and
  NO success narration (the transfer did not occur).
- **c-plan-pause-resume**: gated plan `如果我这个月消费超过2000，就把信用卡娱乐限额调整到1500元`
  → badge `等待确认` → `暂停` → `已暂停` → `继续` (see Known limitation).
- **d-plan-cancel**: gated plan → `等待确认` → plan-card `取消` → badge `已取消`.
- **e-refresh-action-recovery** — two legs (same context across reload): park a YELLOW transfer →
  reload → ConfirmationCard RESTORED from persisted server state; park a RED transfer → reload →
  MfaCard RESTORED.

## Coverage notes
- **Covers:** real-browser NL → card → human-decision flows; MFA success + wrong-code rejection;
  plan pause/resume + cancel; refresh rehydration from persisted server state; structured honest
  reporting; whole-tree teardown.
- **Does NOT cover:** the real LLM (`LLM_MODE=live`); real bank/network; the production build
  (`next build` / `next start`); cross-browser (Chrome only, Edge as fallback and untested);
  visual/a11y regression; load/perf; the security unit + scenario layers (owned by
  `tests/unit` / `tests/scenarios`).

## Known Issues
- **No React-hydration gate — journeys a/b/e are racy (harness-side).** `gotoAgent` (helpers.ts:396)
  returns as soon as the SSR composer `<textarea>` is visible, and `submitChat` (helpers.ts:442) then
  `fill()`s + clicks `发送` with NO wait for React hydration. At that instant the composer carries NO
  React fiber props (`__reactFiber$…`/`__reactProps$…` absent — verified by a real headless-Chrome
  probe), so interacting then (1) DROPS the click (no `POST /api/chat` is issued) and (2) RESETS the
  `fill()` when React hydrates the controlled `<textarea>`. Landing the first turn depends purely on
  Next-dev hydration timing. Grep confirms there is NO hydration signal anywhere in `tests/e2e/`
  (no `__reactFiber$`/`__reactProps$`, no `networkidle`, no `waitForFunction`, no mounted/`data-ready`
  marker). MINIMAL FIX (owner: `helpers.ts`): before `fill()`/click in `submitChat` (and/or at the end
  of `gotoAgent`), wait for hydration — e.g. `page.waitForFunction` that the composer element has a
  `__reactProps$…` key, or add a small client-only `data-hydrated` marker to `Composer` and wait on it.
- **App side is SOUND (not the cause).** With hydration explicitly awaited (fiber props present), a
  real headless-Chrome probe's `fill()`+click issued `POST /api/chat` and the ConfirmationCard
  rendered — so `/agent` hydrates without error, the composer submits, and cards/narration render.
  `GET /agent` returns HTTP 200; `components/chat/index.ts` and `components/index.ts` are neutral
  barrels and the chat leaves carry `'use client'`.
- **Harness dev-server boot fails in this environment (reproduced twice).** The harness's Node
  `spawn('cmd.exe', ['/d','/s','/c','npx next dev -p <port>'], { detached:true, stdio:'pipe' })`
  yields an EMPTY stdout pipe and `/api/health` never becomes ready → after 180s all five journeys
  FAIL with `基础设施失败：/api/health 未就绪` (never reaching a journey interaction). Launching the
  identical command manually (`Start-Process cmd.exe '/d','/s','/c' 'npx next dev -p <port>'`) boots
  fine (`Ready in ~1.2s`, `/api/health` 200). So a harness run can report `PASS 0|FAIL 5` at the
  INFRASTRUCTURE stage alone. Invoke the harness directly (`npx tsx tests/e2e/acceptance.e2e.ts`);
  never wrap it in an extra `cmd /c`.
- **`c-plan-pause-resume` honest limitation:** resuming a plan whose gated node is still parked
  re-attempts that node (parked is NOT terminal), so the plan RE-parks at `等待确认` instead of reaching
  `已完成`. The journey reports whichever badge is actually observed and NEVER fabricates `已完成`.

## Routing Table
- `./acceptance.e2e.ts` → the single real-browser entry point (boot → readiness → journeys → structured report → non-zero exit on FAIL)
- `./helpers.ts` → shared harness (free port, dev-server boot/teardown, health poll, browser factory, `withPage`, DOM selectors/interactions, reporter, fail-fast navigation)
- `./screenshots/` → git-ignored failure screenshots
- `../app` → HTTP route-handler specs (the in-process acceptance layer this harness complements) (sibling — read-only)
- `../setup.ts` + `../helpers` → vitest global setup + fixtures (untouched by this harness) (sibling — read-only)
