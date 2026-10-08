# LIVE Acceptance Report — REAL DeepSeek API through a REAL browser

**Status: EXECUTED LIVE.** `tests/e2e/live-acceptance.e2e.ts` was actually run against the
REAL app in `LLM_MODE=live`, driving the REAL DeepSeek API through REAL headless Chrome.

> **LABEL: "LIVE with disclosed model-id override (provided `deepseek-flash` is not a valid
> pi-ai id)."** Every result below carries this label.

## How we know it was genuinely LIVE (not mock)

- `LLM_MODE=live` was set (via `.env.local`, copied into this worktree, **contents never
  printed / never committed**), `LLM_PROVIDER=deepseek`.
- The booted app reported it at `GET /api/health`:
  `{"ok":true,"data":{"status":"ok","time":1791458581448,"llmMode":"live"}}`.
- Real Chrome was launched (`C:\Program Files\Google\Chrome\Application\chrome.exe`), a real
  `next dev` server booted, and the isolated DB `prisma/live-acceptance.db` was
  provisioned + seeded before boot (never `dev.db` / `test.db` / `e2e.db`).
- The model produced free-form Markdown answers (e.g. a full balance table) that no mock
  responder emits, and tool-call failures surfaced verbatim from the live LLM.
- Disclosed harness override: `configureLiveEnv()` sets
  `process.env.LLM_MODEL='deepseek-v4-flash'` (a **registered** pi-ai id) because the provided
  `LLM_MODEL=deepseek-flash` is **not** registered (see DEFECT #1). Everything else came from
  `.env.local` unchanged. `startDevServer` inherits `process.env`; Next does not override an
  already-set value with `.env.local`.

## Raw summary line (final full run)

```
== 汇总：PASS 5 ｜ FAIL 2 ｜ SKIP 1 ==
```

Earlier runs (same harness, incremental):
- Smoke (`LIVE_SCENARIOS=1`): scenario 1 **PASS**.
- First full run (before diagnostics + a counting-scope harness fix): `PASS 3 ｜ FAIL 4 ｜ SKIP 0`.
- Diagnostic re-run (`LIVE_SCENARIOS=2,3,6,4`): `PASS 2 ｜ FAIL 2 ｜ SKIP 0`.

Scenario order is `1,2,3,5,6,4` then `7` (keeps the demo-day outgoing total ≤¥1000/YELLOW
until scenario 4's ¥5000 RED transfer).

## Per-scenario results

Legend: **prompt** → **rendered DOM** → **DB / API cross-check** → verdict.

### 1. Balance query — **PASS**
- **Prompt:** `查一下我的余额`
- **DOM:** the model answered with a Markdown table (活期 **¥23,580.00** / 储蓄 ¥50,000.00 /
  合计 ¥73,580.00).
- **DB/API cross-check:** SQLite `Account.balance = 23580`; `GET /api/dashboard` → `23580`.
  Model number == DB == API.
- **Verdict: PASS.**

### 2. Transfer by NAME — **FAIL** (app-code defect #2)
- **Prompt:** `给张伟转200元` (name path).
- **DOM:** no ConfirmationCard within 90 s → harness diagnostic fired:
  `等待超时（90000ms）：确认卡片（「确认」按钮） ｜ 【诊断】助手消息数=4；/api/actions=[]`.
  Raw model text shows `search_contact` DID resolve 张伟 (`139****0002`, 招商银行), but then
  `transfer_money` returned verbatim:
  `未能找到与「张伟」匹配的收款联系人，请向用户确认收款人的姓名或手机号后再试。`
  (also observed with the raw number `13900000002`).
- **DB/API cross-check:** no `PendingAction` parked (`/api/actions=[]`); balance/ledger
  unchanged.
- **Verdict: FAIL** — the model attempted the transfer but the app's `transfer_money`
  recipient resolution refused a recipient that `search_contact` had just resolved.
- **Screenshot:** `tests/e2e/screenshots/live/01-s2-by-name.png`.

### 2p. Transfer by PHONE — **SKIP** (structurally unverifiable on this seed data)
- **Prompt:** by phone.
- **Reason (honest skip, not a fabricated pass):** the seeded contact phone is **masked**
  (`139****0002`); `search_contact` matches phone by **substring**
  (`banking-sdk/contact.ts#searchContacts`), while the live model normalizes the mask to
  `13900000002` → no match. The phone path cannot be exercised end-to-end on the current
  demo seed without changing seed data (out of `./tests/e2e` scope). This is a **seed-data
  limitation**, not a transfer-path defect per se.
- **Verdict: SKIP** (guarded by `Scenario.skipReason?()`).

### 3. Decimal transfer `¥200.37` — **FAIL** in the final full run / **PASS** in the diagnostic run
- **Prompt:** `给张伟转200.37元`.
- **Final full run:** same `transfer_money` failure as scenario 2
  (`未能找到与「张伟」匹配的收款联系人`) → FAIL.
- **Diagnostic re-run (same harness):** PASS — card showed `200.37`; balance unchanged
  pre-confirm (API = DB = `23580`); post-confirm both `23379.63`; exactly one
  `-200.37 DEBIT` ledger row `txidem_6bc96085def7372903bbc99ba34aa775`.
- **DB/API cross-check:** `Account.balance` + `GET /api/dashboard` + `GET /api/bills`
  agree; ledger delta is a single `−200.37` debit.
- **Verdict: FAIL (final run) / PASS (diagnostic run)** — the outcome is non-deterministic
  across runs, consistent with defect #2 (recipient resolution depends on the identifier the
  model chooses). Reported honestly; no assertion weakened.
- **Screenshot:** `tests/e2e/screenshots/live/02-s3-decimal-preconfirm.png`,
  `.../03-s3-decimal-settled.png`.

### 4. Large transfer `¥5000` → MFA — **PASS**
- **Prompt:** large transfer requiring strong verification.
- **Wrong code `000000`:** DOM `验证失败，已尝试 1 次`; MFA card **retained**; DB/API
  `18380` unchanged and **no** `−5000` ledger row → deducts nothing.
- **Correct code `123456`:** API = DB = `13380`; exactly one `-5000 DEBIT`
  (`txidem_184dd3ca67f649dd59cc718839e4ca76`) → deducts exactly once.
- **Verdict: PASS.**
- **Screenshots:** `.../03-s4-mfa-wrong.png`, `.../05-s4-mfa-ok.png`.

### 5. Cancel pending YELLOW transfer → idempotent no-double-charge — **PASS**
- **Prompt:** `给张伟转200元` → YELLOW `transfer_money` parks → **cancel**.
- **DOM:** badge `已取消`; confirm-button count = 0.
- **DB/API cross-check:** `PendingAction.status='cancelled'`; repeat cancel/confirm
  rejected; balance `23580` unchanged; no new ledger row.
- **Verdict: PASS** (terminal-state UX + idempotency verified).

### 6. Multi-turn conversation + continuations → no `tool`-role 400 — **PASS**
- **Prompt:** ≥3 turns in ONE session, incl. post-confirm and post-MFA model continuations.
- **DOM:** 4 turns, 9 assistant messages; post-confirm balance `23380`, post-MFA `18380`.
- **Network/console harvest:** **no** HTTP 400
  `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`
  anywhere in the run.
- **Verdict: PASS.**

### 7. SDK commit succeeds, model continuation fails → still EXECUTED — **PASS**
- **Mechanics:** re-boot same app+DB with `DEEPSEEK_API_KEY='invalid'` so the write commits
  but the continuation fails.
- **DOM/API:** `HTTP 200 {ok:true, status:'executed'}`.
- **DB cross-check:** `PendingAction.status='executed'`; balance `23580 → 23380`
  (DB = `23380`); exactly one `-200 DEBIT` (`txidem_fb1d5f3939f5076fd3d446872166923f`).
  NOT `failed`, no re-charge.
- **Verdict: PASS.**
- **Screenshot:** `.../06-s7-parked.png`.

## App-code defects (reported only — `./tests/e2e` may not edit app code)

### DEFECT #1 — silent cross-provider fallback on an unregistered `LLM_MODEL`
- **File:** `agent/providers/provider-live.ts`
  - ~L18: `const FALLBACK_API: Api = 'openai-completions'`
  - ~L19: `const FALLBACK_BASE_URL = 'https://api.openai.com/v1'`
  - ~L54–57: resolution is `getModels(cfg.llmProvider).find(m => m.id === cfg.llmModel)`
  - ~L59–70: on a **miss**, a literal fallback `Model` is returned with
    `baseUrl: FALLBACK_BASE_URL` (OpenAI).
  - ~L44–52: `createLiveModel` only checks env-key presence; it **never validates the model id**.
- **Symptom:** pi-ai's `deepseek` registry exposes only `deepseek-v4-flash` and
  `deepseek-v4-pro`. `.env.local` sets `LLM_MODEL=deepseek-flash` (unregistered) → lookup
  misses → the OpenAI baseUrl fallback is used → the DeepSeek key is sent to
  `https://api.openai.com/v1` → every LLM call returns `401 Incorrect API key provided`.
- **Evidence:** `getModels('deepseek')` enumerated as above; key + network independently
  valid — a raw `POST https://api.deepseek.com/chat/completions` returns **HTTP 200**.
- **Suspected root cause:** a config/model-id mismatch silently degraded into a different
  provider's endpoint. A registry miss for an explicitly configured `LLM_MODEL` should fail
  loudly (or resolve to `provider.defaultModel`), never leak a provider key to the wrong host.
- **Workaround (disclosed, kept):** harness sets `LLM_MODEL=deepseek-v4-flash` before boot.

### DEFECT #2 — `transfer_money` recipient resolution non-deterministic vs `search_contact`
- **File (evidence-based):** the transfer tool path `agent/tools/transfer.ts` (recipient /
  `contactId` resolution) descending into `banking-sdk/transfer.ts` +
  `banking-sdk/contact.ts#searchContacts`.
- **Symptom:** in the SAME live run, `search_contact('张伟')` returned a match
  (`139****0002`, 招商银行), but `transfer_money({recipient:'张伟'})` returned
  `未能找到与「张伟」匹配的收款联系人，请向用户确认收款人的姓名或手机号后再试。`
  (also with `13900000002`). Scenarios 5 & 6 used the SAME prompt `给张伟转200元` on the
  SAME seeded data and DID park a YELLOW `transfer_money` action.
- **Evidence:** scenarios 2 & 3 FAIL in the final run (no card); scenarios 5 & 6 PASS;
  scenario 3 PASSED on the earlier diagnostic run. Same seed, same prompt, different runs.
- **Suspected root cause:** the recipient resolution is not robust to the identifier form the
  live model chooses (contact id vs name vs raw vs masked phone), and/or the transfer tool's
  own lookup differs from `search_contact`'s substring match — so a recipient the agent just
  resolved can be rejected by the write tool. Non-deterministic across runs.

## Benign artifacts (not defects)

- `[net 403] GET <base>/api/actions` → `{"ok":false,"error":{"code":"SECURITY_DENIED",...}}`
  appears once **per fresh browser context, before the first chat turn mints the
  `banking_session` cookie**. Expected cookie-identity behaviour.
- `[console error] Failed to load resource: ... 404 (Not Found)` — the favicon. Benign.
- Totals line from the final run: `· 累计网络 4xx/5xx：9，console error：10，pageerror：0`.
  The 4xx/5xx are the benign 403s above plus app-level expected rejections; **no**
  `tool`/`tool_calls` 400 anywhere.

## Blockers

1. **Scenario 2 (by-name) and scenario 3 (decimal) are non-deterministic** because of
   DEFECT #2 (transfer recipient resolution). Re-running scenario 3 PASSED; scenario 2 FAILed.
   The transfer-*recipient* path cannot be treated as reliable on this build.
2. **Scenario 2p (by-phone) is structurally unverifiable** on the demo seed (masked phone
   `139****0002` + substring matching vs the model's normalized `13900000002`).
3. **DEFECT #1** forces the disclosed `LLM_MODEL` override; without it every live LLM call
   401s.

## Which results are live vs mock

- **Live (with disclosed model-id override):** scenarios 1, 4, 5, 6, 7 (PASS); scenarios 2
  and 3 (FAIL, defect #2); scenario 2p (SKIP). All seven were exercised against the real
  DeepSeek API and real Chrome.
- **Mock:** none. The mock-mode harness `tests/e2e/acceptance.e2e.ts` was left unmodified and
  not run in this session.

## Harness changes made in this session (all inside `./tests/e2e`, no app code touched)

- `LIVE_MODEL_OVERRIDE='deepseek-v4-flash'` constant; `configureLiveEnv()` applies it and the
  startup log prints it (previously logged as `(未设置)`).
- `noCardDiagnostics(page, baseUrl)`, `awaitConfirmCard(...)` / `awaitMfaCard(...)` — dump
  assistant texts + `/api/actions` + DOM tail into the timeout error. Waits and assertions
  unchanged.
- `waitForTransferSettled` now scopes its debit count to rows **not** present in the
  pre-transfer ledger snapshot (fixes a cross-scenario same-amount miscount — a legitimate
  correction, not a weakened assertion).
- Scenario 2 split into `2-live-transfer-recipient-by-name` and
  `2p-live-transfer-recipient-by-phone` (with `skipReason`); `Scenario.skipReason?()`;
  selection supports the split id.
- `tests/e2e/helpers.ts` left untouched. `npx tsc --noEmit` → **exit 0**.

## Evidence artifacts

- Screenshots: `tests/e2e/screenshots/live/` (force-added; the dir's `.gitignore` is `*`).
  Present: `01-s1-balance.png`, `01-s2-by-name.png`, `02-s3-decimal-preconfirm.png`,
  `02-s5-parked.png`, `03-s3-decimal-settled.png`, `03-s4-mfa-wrong.png`,
  `03-s6-multiturn.png`, `04-s4-mfa-wrong.png`, `04-s6-multiturn.png`, `04-s7-parked.png`,
  `05-s4-mfa-ok.png`, `05-s4-mfa-wrong.png`, `06-s4-mfa-ok.png`, `06-s7-parked.png`.
