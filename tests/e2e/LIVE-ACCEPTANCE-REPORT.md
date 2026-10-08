# LIVE Acceptance Report — REAL DeepSeek API through a REAL browser

**Status: EXECUTED LIVE.** `tests/e2e/live-acceptance.e2e.ts` was actually run against the
REAL app in `LLM_MODE=live`, driving the REAL DeepSeek API through REAL headless Chrome.

> **LABEL on EVERY result below: "LIVE with disclosed model-id override (the provided
> `deepseek-flash` is not a valid pi-ai id; the harness forces the registered
> `deepseek-v4-flash`)."**

## How we know it was genuinely LIVE (not mock)

- `LLM_MODE=live`, `LLM_PROVIDER=deepseek` (from `.env.local`, copied into this worktree,
  **contents never printed / never committed** — presence-only).
- The booted app reported it: `GET /api/health` →
  `{"ok":true,"data":{"status":"ok","time":…,"llmMode":"live"}}`.
- Real Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`), a real `next dev`
  server, and the isolated DB `prisma/live-acceptance.db` (provisioned + seeded before boot;
  never `dev.db` / `test.db` / `e2e.db`).
- The model produced free-form Markdown that no mock responder emits, and raw tool-call
  failures surfaced verbatim from the live LLM.
- Disclosed harness override: `configureLiveEnv()` sets `process.env.LLM_MODEL='deepseek-v4-flash'`
  (a **registered** pi-ai id) because the provided `LLM_MODEL=deepseek-flash` is **not**
  registered (see DEFECT #1). Everything else comes from `.env.local` unchanged.
  `startDevServer` inherits `process.env`; Next does not override an already-set value.

## Per-scenario results

Legend: **prompt** → **rendered DOM** → **DB / API cross-check** → **verdict**.

### 1. Balance query — **PASS**
- **Prompt:** `查一下我的余额`
- **DOM:** a Markdown table (活期 **¥23,580.00** / 储蓄 ¥50,000.00 / 合计 ¥73,580.00).
- **DB/API cross-check:** SQLite `Account.balance = 23580`; `GET /api/dashboard` → `23580`.
  Model number == DB == API.
- **Verdict: PASS.**

### 2. Transfer by NAME — **FAIL** (DEFECT #2, PROVEN)
- **Prompts exercised this session:** `给张伟转200元` (canonical) and `给联系人张伟转200元`
  (identifier-pinning alternative). **BOTH FAILED.**
- **DOM:** no ConfirmationCard within 90 s → `等待超时（90000ms）：确认卡片（「确认」按钮）`,
  `助手消息数=3`, `/api/actions=[]`. The assistant narrated the clarify message as a failure,
  e.g. `搜索结果返回的联系人 id 无法用于转账。为避免转错，我需要向您确认收款人信息：- 找到的匹配：
  **张伟（139****0002，招商银行）**`.
- **DB/API cross-check:** `/api/actions=[]` (no `PendingAction` parked); balance/ledger unchanged.
- **Machine summary line (this session's runs):** `== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 1 ==`.
- **Verdict: FAIL** — the write tool refused a recipient the read tool had just resolved.

### 2p. Transfer by PHONE — **SKIP** (structurally unverifiable on this seed data)
- **Reason (honest skip, not a fabricated pass):** the seeded contact phone is **masked**
  (`139****0002`); `search_contact` matches phone by **substring**
  (`lib/db/repositories/contact.ts#searchContacts`), while the live model normalizes the mask to
  `13900000002` → no match. The phone path cannot be exercised end-to-end on the current demo seed
  without changing seed data (out of `./tests/e2e` scope) — a **seed-data limitation**, not a
  transfer-path defect per se.
- **Verdict: SKIP** (guarded by `Scenario.skipReason?()`).

### 3. Decimal transfer `¥200.37` — **FAIL** (same recipient-resolution defect)
- **Prompt:** `给张伟转200.37元` (canonical); alternative `给联系人张伟转200元` variants also tried.
- **Observed:** the same `transfer_money` recipient refusal as scenario 2
  (`未能找到与「张伟」/「139****0002」匹配的收款联系人…`) → no card → FAIL; and a
  diagnostic re-run PASSED (card `200.37`; API = DB = `23580` pre-confirm; API = DB = `23379.63`
  post-confirm; exactly one `-200.37 DEBIT` ledger row). The PASS is the model happening to emit
  the `name` arg instead of the masked phone / a name in the `contactId` slot.
- **DB/API cross-check:** balance + `GET /api/dashboard` + `GET /api/bills` agree; ledger delta is a
  single `−200.37` debit when the action reaches `pending` at all.
- **Verdict: FAIL** — reproducible; a PASS requires the live model to choose the `name` arg shape by
  chance. Not reliable on this build.

### 4. Large transfer `¥5000` → MFA — **PASS**
- **Prompt:** large transfer requiring strong verification.
- **Wrong code `000000`:** DOM `验证失败，已尝试 1 次`; MFA card **retained**; DB/API `18380`
  unchanged and **no** `−5000` ledger row → deducts nothing.
- **Correct code `123456`:** API = DB = `13380`; exactly one `-5000 DEBIT`
  (`txidem_184dd3ca67f649dd59cc718839e4ca76`) → deducts exactly once.
- **Verdict: PASS.** (Requires the recipient to resolve; this run's prompt/model did resolve it.)

### 5. Cancel pending YELLOW transfer → idempotent no-double-charge — **PASS**
- **Prompt:** `给张伟转200元` → YELLOW `transfer_money` parks → **cancel**.
- **DOM:** badge `已取消`; confirm-button count = 0.
- **DB/API cross-check:** `PendingAction.status='cancelled'`; repeat cancel/confirm rejected;
  balance `23580` unchanged; no new ledger row.
- **Verdict: PASS** (terminal-state UX + idempotency).

### 6. Multi-turn conversation + continuations → no `tool`-role 400 — **PASS**
- **Prompt:** ≥3 turns in ONE session, incl. post-confirm and post-MFA model continuations.
- **DOM:** 4 turns, 9 assistant messages; post-confirm balance `23380`, post-MFA `18380`.
- **Network/console harvest:** **no** HTTP 400
  `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'` anywhere.
- **Verdict: PASS.**

### 7. SDK commit succeeds, model continuation fails → still EXECUTED — **PASS**
- **Mechanics:** re-boot the same app+DB with `DEEPSEEK_API_KEY='invalid'` so the write commits but
  the continuation fails.
- **DOM/API:** `HTTP 200 {ok:true, status:'executed'}`.
- **DB cross-check:** `PendingAction.status='executed'`; balance `23580 → 23380` (DB = `23380`);
  exactly one `-200 DEBIT` (`txidem_fb1d5f3939f5076fd3d446872166923f`). NOT `failed`, no re-charge.
- **Verdict: PASS.**

## App-code defects (reported only — `./tests/e2e` may not edit app code)

### DEFECT #1 — silent cross-provider fallback on an unregistered `LLM_MODEL`
- **File:** `agent/providers/provider-live.ts`
  - `FALLBACK_API: Api = 'openai-completions'`; `FALLBACK_BASE_URL = 'https://api.openai.com/v1'`.
  - Model resolution is `getModels(cfg.llmProvider).find(m => m.id === cfg.llmModel)`; on a **miss**
    a literal fallback `Model` is returned with the OpenAI `baseUrl`.
  - `createLiveModel` only checks env-key presence; it **never validates the model id**.
- **Symptom:** pi-ai's `deepseek` registry exposes `deepseek-v4-flash` / `deepseek-v4-pro`.
  `.env.local` sets `LLM_MODEL=deepseek-flash` (unregistered) → lookup misses → the OpenAI baseUrl
  fallback is used → the DeepSeek key is sent to `https://api.openai.com/v1` → every LLM call
  returns `401 Incorrect API key provided`.
- **Evidence:** `getModels('deepseek')` enumerated as above; the key + network are independently
  valid — a raw `POST https://api.deepseek.com/chat/completions` returns **HTTP 200**.
- **Suspected root cause:** a config/model-id mismatch silently degrades into a different provider's
  endpoint. A registry miss for an explicitly configured `LLM_MODEL` should fail loudly (or resolve
  to `provider.defaultModel`), never leak a provider key to the wrong host.
- **Workaround (disclosed, kept):** the harness sets `LLM_MODEL=deepseek-v4-flash` before boot.

### DEFECT #2 — `transfer_money` recipient resolution rejects a masked phone placed in the `contactId` slot — **CONFIRMED (proven, not inferred)**
- **File (evidence-based):** `security/security-gateway.ts#resolveTransferRecipient`
  (requires EXACTLY ONE of `contactId | phone | name`; phone path = `searchContacts(phone)` then
  `c.phone === phone`, else `c.phone.includes(phone)`; name path = `c.name === name`; empty →
  `not_found`), + `buildRecipientClarifyMessage`, backed by
  `lib/db/repositories/contact.ts#searchContacts` (`OR:[{name contains}, {phone contains}]`).
- **PROOF — the persisted tool-call ARGUMENTS, verbatim.** The raw args are not exposed client-side,
  but `AgentSession.stateJson` persists `agentState.messages`; read straight out of the SAME
  `prisma/live-acceptance.db` the run used (parsed, not inferred). Both fresh runs this session
  produced the identical failing shape:

  ```
  msg#1 assistant→ toolCall search_contact args={"query":"张伟"}
  msg#2 toolResult search_contact isError=false
        text=找到 1 位匹配“张伟”的联系人：张伟（139****0002，招商银行）。
  msg#3 assistant→ toolCall transfer_money args={"amount":200,"contactId":"139****0002","remark":"转账"}
  msg#4 toolResult transfer_money isError=true
        text=未能找到与「139****0002」匹配的收款联系人，请向用户确认收款人的姓名或手机号后再试。
  ```

- **Seed value read from the same DB:** `Contact {id:"contact_zhangwei", name:"张伟",
  phone:"139****0002", bank:"招商银行"}` → the phone is **MASKED** (`139****0002`).
- **Root cause (now directly observed, not deduced):** the live model resolves the contact with
  `search_contact`, reads the **masked** phone back from the tool result, and passes that masked
  string in the **`contactId`** slot of `transfer_money`. `resolveTransferRecipient` treats a
  populated `contactId` as an ID: `getContact('139****0002')` misses → owner check fails →
  `not_found` with `supplied='139****0002'`, byte-identical to the observed message. The `phone`
  path is no better against masked seed data (`searchContacts('139****0002')` returns the row by
  substring, but `c.phone === '139****0002'`… actually matches — yet a de-masked `13900000002`
  neither equals nor `includes`/is-included-by the masked value → empty pool). There is **no
  name-fallback** when the chosen slot holds a name- or masked-phone-like value.
- **Observed non-determinism:** the SAME tool + prompt also sometimes succeeds when the model
  emits `name:"张伟"` → the YELLOW action parks
  (`__SECURITY_BLOCK__{"decisionKind":"require_confirmation"}`, `GET /api/actions` →
  `{tool:transfer_money,tier:YELLOW,status:pending,attention:decision}`). A third mode was also seen
  in earlier runs: the model narrates the recipient + amount but **never calls `transfer_money`** on
  that turn (only `search_contact`), leaving `/api/actions=[]`.
- **Arg shapes observed across runs (verbatim):**
  - FAIL: `{"amount":200,"contactId":"139****0002","remark":"转账"}` (this session ×2),
    `{"amount":200,"contactId":"张伟","remark":"转账"}`, `{"phone":"13900000002","amount":200}`,
    `{"contactId":"139****0002","amount":200.37}`, `{"contactId":"张伟","amount":200.37}`.
  - SUCCESS: `{"amount":200,"name":"张伟"}`, `{"amount":200,"name":"张伟","remark":"转账"}`,
    `{"amount":200.37,"name":"张伟"}`, `{"name":"张伟","amount":200.37}`.
- **Mitigation attempt (this session):** the identifier-pinning prompt `给联系人张伟转200元` was run
  LIVE and **also FAILED** with `contactId:"139****0002"` → the failure is **NOT reliably mitigated
  by prompt**; it is a live-model arg-shape choice (using the mask returned by `search_contact`)
  against a resolver that has no fallback for that slot.
- **Blast radius:** whenever the live model echoes the masked/raw phone from `search_contact` into
  `contactId` (or `phone`), a recipient the agent just resolved becomes un-transferable; the write
  tool bounces it and the model narrates the clarify message as a failure. `search_contact`'s
  `ContactView` DOES hand the model the real `id` (`contact_zhangwei`), but the model does not use
  it. A masked phone returned by a read tool that the write tool cannot consume is a
  read/write-contract mismatch.

## Benign artifacts (not defects)

- `[net 403] GET <base>/api/actions` → `{"ok":false,"error":{"code":"SECURITY_DENIED",…}}`
  appears once **per fresh browser context, before the first chat turn mints the
  `banking_session` cookie**. Expected cookie-identity behaviour.
- `[console error] Failed to load resource: … 404 (Not Found)` — the favicon. Benign.
- Totals line from the fresh runs: `· 累计网络 4xx/5xx：1，console error：2，pageerror：0`.
  The 4xx is the benign 403 above; **no** `tool`/`tool_calls` 400 anywhere.

## Blockers

1. **Scenario 2 (by-name) and scenario 3 (decimal) are unreliable** because of DEFECT #2: the live
   model resolves the recipient with `search_contact` and then passes the **masked phone** into the
   `contactId` slot, which the resolver rejects. Two fresh LIVE runs (canonical + alternative prompt)
   BOTH failed; earlier runs passed only when the model happened to emit `name`.
2. **Scenario 2p (by-phone) is structurally unverifiable** on the demo seed (masked phone
   `139****0002` + substring matching vs the model's normalized `13900000002`).
3. **DEFECT #1** forces the disclosed `LLM_MODEL` override; without it every live LLM call 401s.

## Which results are live vs mock

- **Live (with disclosed model-id override):** scenarios 1, 4, 5, 6, 7 = PASS; scenario 2 = FAIL
  (fresh runs this session); scenario 3 = FAIL (reproducible); scenario 2p = SKIP. All were
  exercised against the real DeepSeek API and real Chrome.
- **Mock:** none. The mock-mode harness `tests/e2e/acceptance.e2e.ts` was left unmodified and not run.

## Harness changes (all inside `./tests/e2e`; no app code touched)

- `LIVE_MODEL_OVERRIDE='deepseek-v4-flash'`; `configureLiveEnv()` applies it and the startup log
  prints it.
- `noCardDiagnostics(page, baseUrl)`, `awaitConfirmCard(...)` / `awaitMfaCard(...)` — dump assistant
  texts + `/api/actions` + DOM tail into the timeout error. Waits and assertions unchanged.
- `waitForTransferSettled` scopes its debit count to rows **not** present in the pre-transfer ledger
  snapshot (fixes a cross-scenario same-amount miscount — a legitimate correction, not a weakened
  assertion).
- Scenario 2 split into `2-live-transfer-recipient-by-name` and
  `2p-live-transfer-recipient-by-phone` (with `skipReason`); `Scenario.skipReason?()`; selection
  supports the split id.
- `LIVE_S2_PROMPT` / `LIVE_S3_PROMPT` env overrides for the two transfer prompts (default = the
  canonical `MSG` prompts); assertions and defaults unchanged.
- `readSeedRecipientPhone()` — reads the seeded recipient phone straight from the DB (never throws).
- `persistedRecipientCalls()` — TASK-A EVIDENCE DUMP: parses every `AgentSession.stateJson`, printing
  each `transfer_money` / `search_contact` `toolCall` argument object VERBATIM plus its `toolResult`.
  Printed at the end of every run and embedded in the no-card diagnostic.
- `fetchParkedActions(page, baseUrl)` + `describeActions(actions)` — READ-ONLY `GET /api/actions`
  cross-check (cookie identity); scenarios 2 & 3 assert the parked `transfer_money` action is
  visible there before confirming.
- `npx tsc --noEmit` → **exit 0**.

## Evidence artifacts

- Screenshots under `tests/e2e/screenshots/live/` (force-added; the dir's `.gitignore` is `*`) —
  including the fresh no-card failures `01-s2-no-card.png`, `01-s3-no-card.png` and the success
  captures (`*-s2-by-name.png`, `*-s3-decimal-preconfirm.png`, `*-s3-decimal-settled.png`,
  `*-s4-mfa-*.png`, `*-s6-multiturn.png`, `*-s7-parked.png`, `01-s1-balance.png`).
- Console evidence (not committed — scratch): the two fresh run logs under `%TEMP%`,
  `live-s2-default.txt` (`PASS 0 ｜ FAIL 1 ｜ SKIP 1`) and `live-s2-altname.txt`
  (`PASS 0 ｜ FAIL 1 ｜ SKIP 1`), each containing the verbatim persisted `transfer_money` args block.
