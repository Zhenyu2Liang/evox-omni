# LIVE Acceptance Report — REAL DeepSeek API through a REAL browser

**Status: HARNESS DELIVERED, BUT NO LIVE RUN WAS EXECUTED.**
Every scenario below is **UNVERIFIED**. No live result is claimed, and no mock-mode
result is being presented as live.

- Harness: `tests/e2e/live-acceptance.e2e.ts` (881 lines), committed at `cd35ffe`.
- Type-check: `npx tsc --noEmit` → **exit 0** (clean, whole repo).
- Environment prep: verified — `.env.local` **present** (contents never printed, never
  committed); `./node_modules` is a **Junction** to `d:/projects/banking-agent/node_modules`
  and `./node_modules/next/dist/bin/next` exists (required by helpers' `resolveNextBin()`).

**Blocker:** the turn budget was exhausted during harness construction. The harness was
never booted, so no browser session, no LLM turn and no DB cross-check was ever produced.
Running it once (`npx tsx tests/e2e/live-acceptance.e2e.ts`, budget 30–40 min) is the sole
remaining step. `prisma/live-acceptance.db` provisioning, `prisma/dev.db` and
`prisma/test.db` are all therefore **untouched** (nothing ran).

## Scenario status

| # | Scenario | Status |
|---|----------|--------|
| 1 | Balance query (`查一下我的余额`) → model number == CHECKING balance | **UNVERIFIED** |
| 2 | Transfer by NAME and by PHONE → card shows real resolved name + masked phone, both CANCELLED | **UNVERIFIED** |
| 3 | Decimal transfer `¥200.37` → balance unchanged pre-confirm; post-confirm debit + ledger both `−200.37` | **UNVERIFIED** |
| 4 | Large transfer `¥5000` → wrong MFA `000000` deducts nothing; correct `123456` deducts exactly once | **UNVERIFIED** |
| 5 | Cancel pending YELLOW transfer → no deduction; refresh + repeat-confirm → no double deduction; terminal-state UX | **UNVERIFIED** |
| 6 | Multi-turn (≥3 turns, one session) + post-confirm/post-MFA continuation → no HTTP 400 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` | **UNVERIFIED** |
| 7 | Commit-succeeds-but-continuation-fails → action `executed`, exactly one debit in UI **and** DB | **UNVERIFIED** |

Evidence column (required format: exact action → observed UI result → DB/API query + returned
values → PASS/FAIL) is empty for every row because no run occurred. The report is written
incrementally on purpose; this header is the honest final state.

## Which results are live vs mock

- **Mock:** none. The existing mock-mode acceptance harness (`tests/e2e/acceptance.e2e.ts`)
  was deliberately **not modified** and was not run in this session.
- **Live:** intended for all 7 scenarios, with the disclosed override below — but **not
  executed**.

## DEFECT #1 (app code — reported, NOT fixed; `tests/e2e` may not edit app code)

**File:** `agent/providers/provider-live.ts`

- Line ~18: `const FALLBACK_API: Api = 'openai-completions'`
- Line ~19: `const FALLBACK_BASE_URL = 'https://api.openai.com/v1'`
- Lines ~54–57: resolution is `getModels(cfg.llmProvider as KnownProvider).find(m => m.id === cfg.llmModel)`
- Lines ~59–70: on a miss, a **literal fallback `Model<any>`** is returned with
  `baseUrl: FALLBACK_BASE_URL` (OpenAI).
- Lines ~44–52: `createLiveModel` only checks env-key presence (`getEnvApiKey(cfg.llmProvider)`
  + `getProviders()`); it **never validates the model id**.

**Symptom:** pi-ai's `deepseek` registry exposes **only** `deepseek-v4-flash` and
`deepseek-v4-pro` (`getModels('deepseek')` → `["deepseek-v4-flash","deepseek-v4-pro"]`).
`.env.local` sets `LLM_MODEL=deepseek-flash`, which is **not registered**. The lookup misses,
the literal fallback (OpenAI baseUrl, openai-completions API) is used, and the **DeepSeek key
is sent to `https://api.openai.com/v1`** → every LLM call returns
`401 Incorrect API key provided: ...`. The app appears "live" but is structurally broken
against the configured provider.

**Evidence:** `getModels('deepseek')` enumerated as above; `.env.local` sets
`LLM_MODE=live`, `LLM_PROVIDER=deepseek`, `LLM_MODEL=deepseek-flash`, `DEEPSEEK_API_KEY`
present. The key + network are **valid independently**: a raw
`POST https://api.deepseek.com/chat/completions` returns **HTTP 200**.

**Suspected root cause:** a config/model-id mismatch that the code silently degrades into a
different provider's endpoint instead of failing loudly on an unknown model id. A registry
miss for an explicitly configured `LLM_MODEL` should be a hard startup error (or resolved to
`provider.defaultModel`), never a silent cross-provider fallback that leaks a provider key to
the wrong host.

## Disclosed workaround applied to the harness

`tests/e2e/live-acceptance.e2e.ts#configureLiveEnv()` sets, in `process.env` before booting:

```
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash        # <-- DISCLOSED OVERRIDE
DATABASE_URL=file:<abs>/prisma/live-acceptance.db
```

Everything else uses the provided `.env.local` **unchanged**. `startDevServer` inherits
`process.env` and Next does **not** override an already-set `process.env` value with
`.env.local`. Any future result from this harness must be labelled:

> **"LIVE with disclosed model-id override (provided `deepseek-flash` is not a valid pi-ai id)"**

## Harness design (implemented, unrun)

- Self-contained isolated DB `prisma/live-acceptance.db` (absolute forward-slash `file:` URL),
  reusing `tests/helpers/prisma-cli.ts#provisionSchemaLadder`'s ordered ladder with an
  `afterPush` probe→seed; `prisma/e2e.db`, `prisma/dev.db` and `prisma/test.db` are never
  referenced. `tests/e2e/helpers.ts` was left **untouched** (no behavioural edits).
- Real headless Chrome via `resolveBrowserExecutable()`/`launchBrowser()`.
- HAR-ness required by scenario 6: `page.on('response')` + `page.on('console')` +
  `page.on('pageerror')` collectors; **every 4xx/5xx is logged with URL + status + body
  snippet**; `findToolOrderViolation()` scans for the `tool`-role ordering HTTP 400.
- Every money claim is cross-checked by a throwaway `PrismaClient` (`Account.balance`,
  `Transaction` rows, `PendingAction.status`, `ExecutionReceipt`) **and** the app read routes
  (`GET /api/dashboard`, `/api/bills`, `/api/actions`); model text alone never counts.
- Scenario order `1,2,3,5,6,4` then `7`, so the demo-day transfer total stays ≤¥1000
  (YELLOW) until scenario 4's ¥5000 RED transfer; scenarios 2 and 5 **cancel** (never
  confirm) so no money moves.
- Scenario 7 mechanics confirmed by code reading: `executeAuthorizedAction` performs
  SDK `executeDirect` → atomic `settlePendingAction` (terminal status + result + audit)
  **before** the continuation, and `resumeTurn` catches its own continuation throw into an
  `error` event. So re-booting the same app on the same DB with
  `DEEPSEEK_API_KEY='invalid'` is deterministic: the write commits, status becomes
  `executed`, and the response is still `200 {ok:true,...}`.
- Screenshots are written to `tests/e2e/screenshots/live/` (git-ignored directory) and are
  force-added with `git add -f tests/e2e/screenshots/live`.

## Other app-code observations (informational, from code reading only)

- `agent/providers/provider-live.ts` is the only defect with direct evidence (#1 above).
  No other app-code defect was confirmed, because no live run happened.

## Blockers

1. **Turn budget exhausted** before the first harness run — the primary blocker; all seven
   scenarios are UNVERIFIED for this reason alone.
2. (Standing risk, unexercised) Live DeepSeek journeys depend on the API key having quota and
   no rate limiting; if a run hits either, the affected scenario must be reported
   NOT VERIFIED rather than weakened.
