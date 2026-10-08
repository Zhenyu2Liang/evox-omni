# LIVE Acceptance Report — REAL DeepSeek API through a REAL browser

**Status: EXECUTED LIVE.** Real DeepSeek API · real headless Chrome · real `next dev` · isolated DB.
Final machine summary: **`PASS 7 ｜ FAIL 1 ｜ SKIP 0`** (process exit code 0).

Command (from the repo root):

```
npx tsx tests/e2e/live-acceptance.e2e.ts
```

## How we know it was genuinely LIVE (not mock)

- `LLM_MODE=live`, `LLM_PROVIDER=deepseek`, `LLM_MODEL=deepseek-flash`, `DEEPSEEK_API_KEY` all come
  from `.env.local` (gitignored — **presence-only, values never printed / never committed**).
- The harness loaded `.env.local` into its own `process.env` itself:
  `· 已从 .env.local 载入 4 个环境变量（仅计数，不打印取值）`.
- The booted app reported the resolved mode: `GET /api/health` → `llmMode:"live"`.
- Real headless **Chrome** (system `chrome.exe`), a real **`next dev`** server, and the isolated DB
  **`prisma/live-acceptance.db`** (provisioned + seeded before boot; never `dev.db` / `test.db` / `e2e.db`).
- The model produced **free-form** Markdown and free-form tool-arg shapes that no mock responder
  emits (e.g. `search_contact {"query":"139****0002"}`, a clarify narration on the raw-phone leg).
- **Model id came from `.env.local` UNCHANGED** — no forced override. The harness booted with the
  raw provided `deepseek-flash`:
  `· LIVE with PROVIDED model id（不覆盖 LLM_MODEL：使用 .env.local 的 'deepseek-flash'，由
  provider-live.ts#resolveLiveModel 解析为已注册默认值）`. This is itself the proof that the
  previously-reported DEFECT #1 is fixed (see below).

## Defects that are now FIXED

### DEFECT #1 (provider cross-host fallback) — **RESOLVED**

- **Fix:** `agent/providers/provider-live.ts#resolveLiveModel` (commit `cbc64ea` / `c4ee04d`).
  An unregistered model id for a **known** provider now resolves to that provider's OWN registered
  default — `deepseek-flash` → `deepseek-v4-flash` at `https://api.deepseek.com` (with a loud
  `console.warn`) — instead of silently falling back to the OpenAI `baseUrl`.
- **Evidence:** this run booted with the raw `.env.local` `deepseek-flash` and **every** LLM call
  succeeded — no `401`, no OpenAI host. The 8 real scenarios below all produced genuine model output.

### DEFECT #2 (by-name / masked-phone recipient resolution) — **RESOLVED**

- **Fix:** `security/recipient-resolution.ts` (commit `58a74c41`), which adds mask-aware phone
  matching (`maskAwarePhoneMatch`) and a name/phone fallback to the WRITE path
  (`security/security-gateway.ts#resolveTransferRecipient`).
- **Evidence:** scenario 2 (`给张伟转200元`, by NAME) now parks a confirmation card showing the REAL
  recipient `张伟 / 139****0002` (not "未指定"), and the masked-phone leg of scenario 2p
  (`139****0002`) also resolves and parks correctly. The write path consumes a by-name/masked-phone
  recipient end-to-end.

## Per-scenario results

Legend: **prompt** → **rendered DOM** → **DB / API cross-check** → **verdict**. All results are
cross-checked against the DB/API, never taken from model narration alone.

| # | Scenario | Verdict |
|---|----------|---------|
| 1 | `1-live-balance-matches-db` | **PASS** |
| 2 | `2-live-transfer-recipient-by-name` | **PASS** |
| 2p | `2p-live-transfer-recipient-by-phone` (masked leg) | **PASS** |
| 2p | `2p-live-transfer-recipient-by-phone` (raw-phone leg) | **FAIL** |
| 3 | `3-live-decimal-transfer-200.37` | **PASS** |
| 5 | `5-live-cancel-idempotent-terminal-ux` | **PASS** |
| 6 | `6-live-multiturn-and-continuations` | **PASS** |
| 4 | `4-live-large-transfer-mfa` | **PASS** |
| 7 | `7-live-committed-continuation-failed` | **PASS** |

Machine summary: **`== 汇总：PASS 7 ｜ FAIL 1 ｜ SKIP 0 ==`**.

### 1. `1-live-balance-matches-db` — **PASS**
- **Prompt:** `查一下我的余额`
- **DOM:** assistant shows `¥23,580.00`.
- **DB/API cross-check:** `Account.balance = 23580`; `GET /api/dashboard = 23580`.
- **Verdict: PASS** — DOM == DB == API (all three agree).

### 2. `2-live-transfer-recipient-by-name` — **PASS**
- **Prompt:** `给张伟转200元`
- **DOM:** confirmation card shows recipient `张伟 / 139****0002` — the REAL name + masked info,
  **NOT** "未指定".
- **DB/API cross-check:** `GET /api/actions` →
  `{tool:transfer_money, tier:YELLOW, status:pending, attention:decision}`. Cancelled →
  balance `23580` unchanged, no new ledger row.
- **Verdict: PASS** — proves DEFECT #2 (by-name resolution) is fixed.

### 2p. `2p-live-transfer-recipient-by-phone` — **FAIL (raw-phone leg only)**
Two legs inside this scenario:
- **MASKED-phone leg (`139****0002`) → PASS.** Persisted tool args (verbatim):
  `search_contact {"query":"139****0002"}` → `找到 1 位匹配"139****0002"的联系人：张伟` →
  `transfer_money {"amount":200,"phone":"139****0002","name":"张伟","remark":"转账"}` →
  `__SECURITY_BLOCK__ {decisionKind:"require_confirmation"}` (card parked).
- **RAW-phone leg (`13900000002`) → FAIL.** `search_contact {"query":"13900000002"}` →
  `未找到匹配"13900000002"的联系人。` → the model never calls `transfer_money` → `/api/actions=[]`
  → confirm-card timeout (90 s). Assistant text:
  `未找到与该手机号匹配的联系人，暂时无法确定收款人…`.
- **Verdict: FAIL** (raw-phone leg). Root cause + fix location in "Residual FAIL" below.

### 3. `3-live-decimal-transfer-200.37` — **PASS** (previously FAILING; now PASSES)
- **Prompt:** `给张伟转200.37元`
- **DOM:** confirmation card amount `200.37`.
- **DB/API cross-check:** `GET /api/actions` →
  `{tool:transfer_money, tier:YELLOW, status:pending, attention:decision}`. **BEFORE** confirm:
  balance unchanged (API = 23580, DB = 23580). **AFTER** confirm: API = `23379.63`,
  DB `Account.balance = 23379.63`, exactly ONE new `-200.37 DEBIT` ledger row
  (`txidem_1220e43ef49900b83fe6f10aca4f640c`).
- **Verdict: PASS** — matches to the cent, debited exactly once.

### 5. `5-live-cancel-idempotent-terminal-ux` — **PASS**
- **Prompt:** `给张伟转200元` → cancel.
- **DOM:** card shows `已取消`; confirm-button count 0 → no debit.
- **DB/API cross-check:** `PendingAction.status='cancelled'`; a repeated cancel on the terminal action
  is rejected; a repeated confirm is rejected → balance `23379.63` unchanged, no new ledger row.
- **Verdict: PASS** — terminal-state UX + idempotency.

### 6. `6-live-multiturn-and-continuations` — **PASS**
- **Prompt:** 4 turns in ONE session (balance → transfer 200 confirm → transfer 5000 MFA → card limit).
- **DOM:** 9 assistant messages; post-confirm balance `23179.63`, post-MFA `18179.63`.
- **Network harvest:** **NO** `tool`/`tool_calls` protocol `400` anywhere; the only 4xx are the benign
  per-context `403` (below).
- **Verdict: PASS.**

### 4. `4-live-large-transfer-mfa` — **PASS**
- **Wrong code `000000`:** DOM `role=status` `验证失败，已尝试 1 次`; MFA card **retained**; balance
  (API = DB = `18179.63`) and ledger **UNCHANGED**.
- **Correct code `123456`:** API = DB = `13179.63` (−¥5000 exactly once); exactly ONE new
  `-5000 DEBIT` (`txidem_c50287c4ec6c26cafb39d6ab82f283ba`).
- **Verdict: PASS.**

### 7. `7-live-committed-continuation-failed` — **PASS**
- **Mechanics:** re-boot the same app + DB with an **invalid** key so the SDK write commits but the
  model continuation fails.
- **DOM/API:** confirming still returns `HTTP 200 {ok:true, status:'executed'}`.
- **DB cross-check:** `PendingAction.status='executed'`; balance `23580 → 23380` (DB = `23380`);
  exactly ONE `-200 DEBIT` (`txidem_bd99e6b1f2664e836c37123957bc0bab`). **NOT** `failed`, no re-charge.
- **Verdict: PASS.**

## Residual FAIL — S2p raw-phone leg (APP read-path gap, OUTSIDE `./tests/e2e`)

The only residual FAIL is the raw-phone leg of scenario 2p. It is an **APP read-path gap**, not a
money-path defect:

- **Layer / location:** `lib/db/repositories/contact.ts#searchContacts` matches the phone by
  **plain substring** — `OR:[{name:{contains:keyword}}, {phone:{contains:keyword}}]`. Against the
  masked seeded phone `139****0002`, the raw `13900000002` does **not** substring-match, so the read
  tool returns nothing and the model never proceeds to `transfer_money`.
- **Why the write path is fine:** the mask-aware matching added by the DEFECT #2 fix
  (`security/recipient-resolution.ts#maskAwarePhoneMatch`) was applied ONLY to the **WRITE** path
  (the security gateway's transfer-recipient resolution). The READ tool `search_contact` was **not**
  made mask-aware. The seeded phones are **all masked** (`prisma/seed.ts`: 张伟 `139****0002`,
  李明 `138****0001`).
- **Blast radius:** only `search_contact`'s raw-phone read; the masked-phone leg of 2p and scenario 2
  both prove the WRITE path resolves and parks correctly.
- **Escalation (do NOT edit app code from this node):** fix `search_contact` / `searchContacts` to be
  **mask-aware**, mirroring `maskAwarePhoneMatch`, and add a unit test.

## Benign artifacts (not defects)

- `GET /api/actions 403 SECURITY_DENIED` appears **once per fresh browser context, before the first
  chat turn mints the `banking_session` cookie** — expected cookie-identity behaviour.
- `Failed to load resource: … 404 (Not Found)` — the favicon. Benign.

## Blockers

- **The only blocker to a CLEAN full pass is the S2p raw-phone APP read-path gap** (root cause above:
  `search_contact` / `searchContacts` is not mask-aware against masked seed phones). It is an APP-side
  fix outside `./tests/e2e`.
- **Infrastructure flake (not app):** one transient `next dev` boot flake occurred on an earlier full
  attempt (`/api/health fetch failed`, empty dev log) and cleared on retry.
- **No API-balance / rate-limit / network blocker was hit:** every DeepSeek call succeeded.

## MOCK vs REAL-live separation

- **REAL live DeepSeek (this report):** all 8 scenarios above (1, 2, 2p, 3, 5, 6, 4, 7) were driven
  against the REAL DeepSeek API through REAL Chrome. The live harness scripts **nothing** — the model
  is genuinely live; only the bank is simulated (SQLite).
- **MOCK:** `tests/e2e/acceptance.e2e.ts` is the SEPARATE scripted-mock browser suite
  (`LLM_MODE=mock`); it was **NOT run and NOT changed** in this live acceptance. The mock plan path
  lives in `agent/providers/mock-responder.ts`.

## Harness state (current)

- Loads the worktree-root `.env.local` into its own `process.env` before booting (simple `KEY=VALUE`
  parse); the spawned `next dev` inherits it. Key value never printed / logged / committed.
- **`LIVE_FORCE_MODEL` is an OPT-IN model override; by DEFAULT it does NOT override** — the run
  exercises `provider-live.ts#resolveLiveModel` on the PROVIDED `.env.local` id.
- `LIVE_SCENARIOS=<ids>` subset selection (ids `1,2,2p,3,4,5,6,7`; selecting `2` also pulls `2p`).
- Retry / nudge logic for the flaky park (`PARK_ATTEMPTS`).
- A single idempotent `cleanup()` stops the **ACTIVE** dev server (including the scenario-7 reboot)
  and closes the browser, wired to `exit` / signals.
- `awaitSessionCookie()` — a bounded wait for the `banking_session` cookie.
- `npx tsc --noEmit` is **clean** (exit 0).
- NOTE: the harness does **not** force `deepseek-v4-flash` — that override is gone/opt-in only.

## Evidence artifacts

11 screenshots committed under `tests/e2e/screenshots/live/` (force-added — the dir's `.gitignore` is
`*`):

| File | What it shows |
|------|---------------|
| `01-s1-balance.png` | S1 balance query result |
| `02-s2-by-name.png` | S2 by-name confirmation card showing the recipient `张伟 / 139****0002` |
| `03-s2-by-phone-masked.png` | S2p masked-phone confirmation card |
| `04-s2-by-phone-raw-no-card.png` | S2p raw-phone leg — no card (the FAIL) |
| `05-s3-decimal-preconfirm.png` | S3 decimal `200.37` before confirm |
| `06-s3-decimal-settled.png` | S3 decimal settled |
| `07-s5-parked.png` | S5 parked YELLOW transfer |
| `08-s6-multiturn.png` | S6 multi-turn session |
| `09-s4-mfa-wrong.png` | S4 wrong MFA code retained card |
| `10-s4-mfa-ok.png` | S4 correct MFA code success |
| `11-s7-parked.png` | S7 committed write parked |
