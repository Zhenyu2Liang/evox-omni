# tests/e2e — REAL-BROWSER End-to-End Acceptance Harness

## Intent
Self-contained, real-browser acceptance suite proving the AI Banking Agent demo works through the
REAL UI. It boots the actual Next.js dev server on a runtime-picked free port, launches the machine's
real headless Chrome via `playwright-core` (NO browser download), drives the real `/agent` page and
asserts on RENDERED DOM. Only the model is scripted (`LLM_MODE=mock`); app, route handlers, security
gateway, banking SDK and SQLite are the real ones.

## API Surface
- `helpers.ts` — free-port picker, `startDevServer`/`waitForHealth`, real-Chrome `launchBrowser`,
  process-tree `killProcessTree` + `DevServer.stop()`, `withPage` (fresh isolated context per journey,
  screenshot + pageerror capture on failure), DOM helpers (`gotoAgent`, `submitChat`,
  `waitForConfirmCard`/`clickConfirm`, `waitForMfaCard`/`submitMfa`, `waitForStatusText`,
  `planCard`/`planStatus`/`waitForPlanStatus`/`clickPlanControl`, `waitForAssistantText`),
  structured `createReporter`/`runJourney` (one `PASS|FAIL|SKIP` line per journey).
- `acceptance.e2e.ts` — the SINGLE entry script (5 journeys a–e). Filename is `.e2e.ts` on purpose:
  it must NOT match vitest's include glob `tests/**/*.{test,spec}.ts`.
- `screenshots/.gitignore` — ignores everything but itself (failure screenshots are never committed).

## How to run
1. `npm install`
2. `npx prisma generate`
3. `npx prisma db push`
4. `npm run db:seed`
5. `npx tsx tests/e2e/acceptance.e2e.ts`

Exit non-zero iff ANY journey FAILED (SKIP does not fail the run). Exactly one structured line per
journey: `PASS|FAIL|SKIP <journey> — <evidence|reason>`.

## Prerequisites
- `.env` committed with `LLM_MODE=mock` and `DATABASE_URL="file:./dev.db"`.
- A real browser present. Real Chrome first, Edge fallback; `E2E_BROWSER_PATH` overrides detection.
  Known paths: `C:\Program Files\Google\Chrome\Application\chrome.exe`,
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. NEVER run `playwright install`.
- Mock MFA code `123456`; demo clock pinned to 2026-09-25 12:00.

## Journeys (assert on RENDERED DOM)
- `a-transfer-confirm` (COVERS): `给张伟转200元` → ConfirmationCard(确认/取消) → 确认 → assistant
  MessageBubble shows `转账处理结果：`. Does NOT cover: the money-move DB row itself, amounts in UI.
- `b-transfer-mfa` (COVERS): RED `给张伟转2000元` → MfaCard(身份验证) → code `123456` → success
  narration; then a FRESH context: same msg → wrong code `000000` → role=status `验证失败，已尝试 1 次`,
  MfaCard stays, NO success narration. Does NOT cover: circuit-breaker trip (needs 3 tries).
- `c-plan-pause-resume` (COVERS): gated plan `如果我这个月消费超过2000，就把信用卡娱乐限额调整到1500元`
  → 等待确认 → 暂停 → 已暂停 → 继续 → real post-resume badge. LIMITATION (documented, never faked):
  per `planner/` semantics, resuming a plan whose gated node is parked RE-ATTEMPTS the node and
  re-parks it, so the observed post-resume badge is expected to be `等待确认`, NOT `已完成`. The journey
  asserts `等待确认`|`已完成` and reports exactly which was observed.
- `d-plan-cancel` (COVERS): gated plan → 等待确认 → plan card 取消 → 已取消.
- `e-refresh-action-recovery` (COVERS): park YELLOW transfer → `page.reload()` in the SAME context
  (HttpOnly `banking_session` cookie persists) → ConfirmationCard restored from `GET /api/actions`;
  and a fresh-context leg: park RED transfer → reload → MfaCard restored.

## Constraints
- Offline & deterministic: mock LLM only, no network to real LLMs.
- Files under `tests/e2e/` are type-checked by `tsc --noEmit` (tsconfig `include: **/*.ts`) and MUST
  NOT contain `.test.`/`.spec.` in their names.
- Relative imports / node built-ins only (no `@/` alias) to avoid tsx path surprises.
- ALWAYS tear down: the dev server's WHOLE process tree (Windows `taskkill /pid <pid> /T /F`) plus the
  browser, on success/failure/unexpected error, via `process.on('exit'|'SIGINT'|'SIGTERM'|
  'uncaughtException'|'unhandledRejection')`. Never leave a dev server listening.
- Wait on real DOM conditions (`waitForSelector`, polling) — never fixed sleeps; generous timeouts for
  Next dev cold-compile latency (`DEFAULT_TIMEOUT_MS = 45s`, `NAV_TIMEOUT_MS = 180s`).

## Routing Table
- `./helpers.ts` — shared harness (boot, browser, DOM, reporter)
- `./acceptance.e2e.ts` — the single entry script (journeys a–e)
- `./screenshots/` — git-ignored failure screenshots (`*` + `!.gitignore`)

## Notes for Agents
- Windows boot quirk: `npx` is `npx.cmd`, so `startDevServer` spawns `cmd.exe /d /s /c "npx next dev -p <port>"`
  (detached, NO `shell:true`). Node's `shell:true` produced an EMPTY stdout pipe here and `/api/health`
  never came up — do not reintroduce it.
- Next dev warns about multiple lockfiles in this worktree layout (harmless).
- PowerShell stdout capture is unreliable here; redirect to a file and read it.
