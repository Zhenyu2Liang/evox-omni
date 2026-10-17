# LIVE acceptance — virtual-card round (real DeepSeek model + real browser)

Real `LLM_MODE=live` DeepSeek API · real headless Chrome · real `next dev` · isolated DB per entry.
No mock, no response interception, no direct SDK/HTTP call standing in for a frontend action.

Everything below was produced at this work cycle's HEAD unless a section explicitly says otherwise.
History lives in Git (`git log -p -- tests/e2e/LIVE-ACCEPTANCE-REPORT.md`); this file records only the
current state of the evidence.

## Verdict table (this cycle)

| Scenario / suite | Rounds | Verdict | Exit code | Evidence |
| --- | --- | --- | --- | --- |
| `lD` virtual card apply + monthly-limit enforcement through the real UI | 3 independent processes | **PASS 3/3** | `0` each | `output/playwright/live/REPORT-lD-round{1,2,3}.md`, `output/playwright/live/lD-round{1,2,3}/` |
| `lE` virtual card 挂失 → 补办 → consume on the new card | 3 independent processes | **PASS 3/3** | `0` each | `output/playwright/live/REPORT-lE-round{1,2,3}.md`, `output/playwright/live/lE-round{1,2,3}/` |
| `lA` + `lC` regression legs (combined selection, one process) | 2 independent processes | **PASS 2/2** | `0` each | `output/playwright/live/REPORT-lA-lC-round{1,2}.md`, `output/playwright/live/lA-lC-round{1,2}/` |
| Mock browser suite `acceptance.e2e.ts` | 1 | **PASS 23 / FAIL 0 / SKIP 0** | `0` | `output/playwright/REPORT-mock-suite.md` |
| Date-tampering boundary `date-tamper-boundary.e2e.ts` (raw HTTP) | 1 | **PASS 8 / FAIL 0 / SKIP 1** | `0` | `output/playwright/REPORT-date-tamper-boundary.md` |
| `pnpm typecheck` | 1 | **0 diagnostics** | `0` | `logs/typecheck.log` (self-test proof in the mock/date-tamper report) |

Every entry above was checked on **both** the exit code and the printed summary line; a printed `PASS`
with a non-zero exit code would have been recorded as a FAILURE. No round was re-run until green and
presented as the only result — every round's real outcome is in its per-round report.

## How "live" is proven

- `.env.local` supplies `LLM_MODE=live` / `LLM_PROVIDER=deepseek` / `LLM_MODEL=deepseek-flash` /
  `DEEPSEEK_API_KEY` (gitignored; presence-only — the value was never printed, echoed or committed).
- `GET /api/health` → `{"ok":true,...,"llmMode":"live"}` on the booted app, every run.
- Resolved model id read from the persisted `AgentRunEvent(eventType='provider_request_payload').payloadJson.model`
  → `deepseek-flash`. `LIVE_FORCE_MODEL` was **not** set, so `.env.local`'s id was used unchanged.
- 100% of tool calls carry a gateway `PendingAction` (RED, `requiresMfa=true`) and a `MfaChallenge`
  row; the code `123456` was typed into the real MFA card in the real browser.
- `prisma/live-acceptance.db` is reprovisioned per run (`db push` → probe → `seed.ts`). Never
  `dev.db` / `test.db`, never a user backup, never a `.env.local` edit.

## `lD` — virtual card apply + limit enforcement (3 rounds, PASS 3/3)

Command per round (identical, separate process):

```
$env:LIVE_SCENARIOS='lD'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

Summary line verbatim, all three rounds: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`, exit code `0`.

**Prompt actually sent** (turn 1 of the bounded candidate list; turns 2–4 were never needed):

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

The consume and over-limit legs are pure `/cards` dialog submissions — **0 model turns**.

**What the model did** (per round): `describe_turn {"operations":["apply_virtual_card"],"purpose":"operation"}`
→ `get_cards {}` (round 1 only; rounds 2–3 went straight to the write) → `apply_virtual_card {"monthlyLimit":"100.00"}`.
Round 3 emitted `{"monthlyLimit":"100"}`, which the gateway normalized to `"100.00"`
(`monthlyLimitMinor=10000`). All invocations `completed`, `attempt=1`.

**Panel reality**: a real confirmation/MFA panel appeared every round (`PendingAction`
`toolName=apply_virtual_card`, `riskLevel=RED`, `requiresMfa=true`, `status=executed`; `MfaChallenge`
`verified`, `attempts=0/3`), completed with the simulator code. No clarification, no nudge, no retry,
no timeout, no fabricated-panel claim (`assertNoFabricatedConfirmationPanel` never fired).

**Raw `Card` row** (identical shape every round): `type=VIRTUAL`, `status=ACTIVE`, `network=UnionPay`,
`monthlyLimitMinor=10000`, `linkedAccountId=acct_checking`, **`creditLimitMinor=null`**,
**`availableLimitMinor=null`**. New masks `****1299` / `****4531` / `****2549`. `/cards` renders
账户可用余额 / 当前可支付金额 only — no 信用额度 / 可用额度 anywhere. The card is never presented as
a credit card.

**Money movement** (round 1 / 2 / 3):

| Item | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| Checking balance minor | `2358000` → `2355000` | same | same |
| New `channel=CARD`/`direction=DEBIT` `Transaction` | `cmvbyucw1006n4of8y5ijlco3` (−`3000`) | `cmvbywc930041zof83mloao5u` (−`3000`) | `cmvbyxiw8004x98f8q2mt4fak` (−`3000`) |
| New `CardConsumption` | `cmvbyucw2006o4of8l0u4uk66` (`3000`) | `cmvbywc940042zof80zmwtvag` (`3000`) | `cmvbyxiw8004y98f8aq7azch5` (`3000`) |
| Server-projected payable | `100.00` → `70.00` | same | same |
| Over-limit attempt `80.00` | `422` `LIMIT_EXCEEDED` `超过虚拟卡月限额。` / screen `超出本月消费限额`, payable stays `70.00`, **zero** funds/ledger/consumption movement | same | same |

Payable is the server projection `min(account available cash, remaining monthly allowance)`, verified
at each stage — not a model-invented number.

## `lE` — 挂失 → 补办 → consume on the new card (3 rounds, PASS 3/3)

Command per round: `$env:LIVE_SCENARIOS='lE'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`.
Summary verbatim `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`, exit code `0`, all three rounds.

**Prompts actually sent**:

```
apply : 请帮我新开一张虚拟卡，月消费限额设为100元
挂失  : 我刚才新办的那张虚拟卡（尾号<该轮真实尾号>，月限额100元）丢失了，请帮我正式挂失这张卡
补办  : 请为我刚才挂失的虚拟卡（原卡尾号<该轮真实尾号>）补办一张新卡
```

Tails: `4715` / `0178` / `1421` per round (the masks the harness had just created — no invented data).

**Turns**: round 1 and 2 resolved every leg on turn 1. **Round 3's 补办 leg needed one extra scripted
turn** (`确认，请为我补办`) because the model answered in prose without emitting a controlled tool call;
`depends_on` that turn the real `replace_card` ran. This is the bounded-nudge path working as designed —
it is recorded here as a turn-count difference, not hidden.

**Tool calls** (identical shape, all rounds, all `completed` / `attempt=1` / `errorCode=null`):
`apply_virtual_card {"monthlyLimit":"100.00"}` → `report_lost_card {"cardId":"<source>","reason":"…申请正式挂失"}`
→ `replace_card {"cardId":"<source>"}`. Three `PendingAction` rows per round (RED, `requiresMfa=true`,
`status=executed`) and three `MfaChallenge` rows per round (all `verified`, `attempts=0`). No wrong code,
no lock, no re-prompt, no fabricated-panel claim.

**DB cross-check** (RAW `Card` rows):

- Source card stays terminal `LOST` with `replacedByCardId` set; the 挂失 leg moved **zero** funds.
- **Exactly one** new `VIRTUAL`/`ACTIVE` card, **same `linkedAccountId=acct_checking`** as the source
  (the inheritance fix is live), new masked number (`4715→3915`, `0178→9937`, `1421→7062`),
  `monthlyLimitMinor=10000`, `creditLimitMinor`/`availableLimitMinor` null.
- **Monthly allowance continues, never resets**: `100.00` (apply) → `70.00` (after the `30.00`
  pre-lost spend) → **`70.00` after 补办** (rendered `当前可支付金额 = ¥70.00`, never `100.00`) →
  `0.00` (after the `70.00` spend) → `0.00` (after a refused `1.00`).
- Pre-lost spend on the source: one `-3000` CARD/DEBIT `Transaction` + one `CardConsumption(3000)`,
  balance `2358000 → 2355000`.
- Spend on the replacement, exactly once: one `channel=CARD`/`direction=DEBIT`
  `Transaction(−7000)` + one `CardConsumption(7000)` on the replacement card, balance
  `2355000 → 2348000`. Transaction ids / consumption ids / `executionKey` per round are in the
  per-round reports.
- Refused `1.00` after exhaustion: `422` `LIMIT_EXCEEDED`, zero tx, zero consumption, unchanged balance.
- Available credit does **not** double: the only non-`LOST` `CREDIT` row is `card_credit`
  (`1800000` minor = ¥18,000.00); the `LOST` source contributes nothing and no virtual card carries
  credit fields.

## `lA` + `lC` regression legs (2 rounds, PASS 2/2)

Command per round: `$env:LIVE_SCENARIOS='lA,lC'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
→ `== 汇总：PASS 2 ｜ FAIL 0 ｜ SKIP 0 ==`, exit code `0`, twice. The combined selection is the real
check: `lA` adds a replacement credit card in the same process/DB, and `lC`'s card-count assertion is
baseline-relative.

**Prompts actually sent**:

```
lA 挂失   : 我的信用卡丢失了，请帮我正式挂失尾号6688的信用卡
lA 补办   : 请为我挂失的信用卡补办一张新卡
lA 幂等腿 : 同一条补办提示一次（round 1 第二轮重放既有结果；round 2 追加
            请再提交一次这张卡的补办申请，我要确认不会重复发卡，模型三次均只作散文拒绝）
lC 确认腿 : 我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？
            那我这张虚拟卡当前最多可以支付多少钱？
lC 消费腿 : 真实 /cards 对话框，amount=88.00, category=购物, merchant=虚拟卡消费验证（0 模型轮次）
```

`lA` legs 1 and 2 each parked a real MFA panel on turn 1 and were completed with `123456`; `lC`'s
confirmation leg produced **no** panel (nothing to confirm — the model only called `get_cards`), and no
fabricated-panel claim occurred.

**`lA` DB cross-check**: source `card_credit` stays `LOST`; exactly one new ACTIVE CREDIT card
(`****6827` / `****7185`) with limit/available/monthly `1800000`; **non-LOST credit total
`18000.00` → `18000.00`** — the naive all-CREDIT sum would be `36000.00` (the doubling bug signature),
explicitly computed and excluded. Card total 4, exactly one ACTIVE credit card; the idempotency leg
added no third card (round 1 replayed the existing receipt; round 2 the model refused in prose three
times — both allowed by the assertion, neither changed card count or limits).

**`lC` DB cross-check**: exactly one new `channel=CARD`/`direction=DEBIT` `Transaction`
(`−8800` = ¥88.00), one new `CardConsumption(8800)`, balance `2358000 → 2349200` (debited once),
payable `min(23492.00, 4912.00) = 4912.00` (rendered `¥4,912.00`). Server-owned booking time proven:
the captured POST body keys are **`amount, category, executionKey, merchant` — no `occurredAt`**, and
`Transaction.occurredAt` == `CardConsumption.occurredAt` == `2026-09-25T04:00:00.000Z` (`DEMO_NOW`).

## Date-tampering boundary — SEPARATE from the browser flows

`tests/e2e/date-tamper-boundary.e2e.ts` — raw HTTP against the running app, **its own isolated DB
`prisma/live-acceptance-date-tamper.db`** (≠ `e2e.db` / `test.db` / `dev.db`), no model, no browser,
no DOM. It is deliberately a different entry from `live-acceptance.e2e.ts`: nothing in it is a
frontend-interaction assertion, and nothing in the browser scenarios asserts a forged timestamp.

`pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts` → `SUMMARY cases=9 pass=8 fail=0 skip=1 → exit code 0`.

The user's repro, replayed end-to-end: create a VIRTUAL card with monthly limit `100.00` through the
real routes (`POST /api/cards` → `POST /api/cards/changes/[id]/verify` with `{"code":"123456"}`) →
consume `10.00` normally → `POST /api/cards/[id]/consume` with `90.00` and a **previous-month**
`occurredAt` (`2026-08-01T04:00:00.000Z`) → **`400`**
`{"ok":false,"error":{"code":"VALIDATION","message":"Consumption time is server-owned: 'occurredAt' must not be sent"}}`
with **zero** movement (balance `23570.00` unchanged, consumption count 1, month total `10.00`,
`forgedAmountRows=0`) → consume `1.00` normally → **month booked total exactly `11.00`**.

Same refusal, same zero side effects, for a future date (`2026-12-24T04:00:00.000Z`), a malformed date
(`"not-a-date"`) and `occurredAt: null`. Payable afterwards `89.00 = min(23569.00, 100.00 − 11.00)`.

Honest **SKIP**: `x1-model-seam-http` — the model-facing refusal in `agent/tools/card.ts`
(`消费入账时间由服务端决定`) is not reachable over HTTP (no route turns arbitrary tool arguments into a
`PendingAction`), so only the HTTP route contract is proven.

## Mock suite (kept green)

`pnpm exec tsx tests/e2e/acceptance.e2e.ts` → `== 汇总：PASS 23 ｜ FAIL 0 ｜ SKIP 0 ==`, exit code `0`,
`prisma/e2e.db`, real headless Chrome. Notable: `b-transfer-mfa` wrong code → `验证失败，已尝试 1 次`
with the card retained and no movement; `j-circuit-breaker-lock` three wrong codes lock the owner
across a reload; `f-wedge-refresh-recover` settles the receipt exactly once; `h-investment-flow`
`−1000.00` DEBIT / `+6178.36` CREDIT.

## Earlier rounds inside this work cycle (not erased by the green re-runs)

- Rounds 1 and 2 of a combined `LIVE_SCENARIOS='lA,lC'` run **FAILED**, both with
  `确认虚拟卡后卡片总数应仍为 3，实际 4：card_credit:CREDIT:LOST,card_debit:DEBIT:ACTIVE,card_virtual:VIRTUAL:ACTIVE,<new>:CREDIT:ACTIVE`
  at `tests/e2e/live-acceptance.e2e.ts:1603`. An `LIVE_SCENARIOS='lC'`-alone diagnostic passed, pinning
  the cause to a stale literal card count combined with cross-scenario state coupling (`lA` legitimately
  adds a replacement card first). Fixed by making the assertion **baseline-relative**; rounds 3–4 then
  passed. This was a test-side defect, not a product defect.
- `lD` and `lE` were also run 3/3 green before the shared-primitive refactor; the runs tabulated above
  are post-refactor and at the current HEAD, so they are the ones that certify the current code.
- Known non-determinism observed across this cycle, all model-side and none a product defect: the model
  occasionally answers a money prompt in prose without emitting the controlled tool call, so no
  `PendingAction` is created. The harness absorbs this with a *bounded* list of natural-language turns
  (`VC_APPLY_TURNS`, `vcReportLostTurns`, `vcReplaceTurns`, `driveRedTool`) and never fabricates a panel;
  a claim that a panel exists while `/api/actions` is empty and the DOM has no card is a hard failure
  (`helpers.ts#assertNoFabricatedConfirmationPanel` + `panel-claim.e2e-helper.ts#findConfirmationPanelClaim`).

## NOT verified by these runs

- **Scenarios not re-run this session**: `lB` and live ids `0`–`15`, `2p`, `7`. Their last verified
  results stand at earlier commits; nothing here certifies them at the current HEAD.
- **Model-facing date refusal** in `agent/tools/card.ts` (SKIP `x1`) and the `/cards` consume dialog's
  behaviour when a tampered body is sent — the boundary entry drives no UI, and the live scenarios never
  send a time argument.
- **MFA wrong-code / circuit-breaker paths under the live model** (only the correct code was submitted;
  `attempts=0/3` everywhere). The mock suite covers the lock path, not the live model.
- **`lE` available credit** was derived from RAW `Card` rows (sum of non-`LOST` `CREDIT` limits), not
  from a post-run dashboard API read.
- **`lD`'s over-limit HTTP status** was read from the harness network log (`[net 422] … LIMIT_EXCEEDED`)
  plus the on-screen `role="alert"` text; no independent `curl` repro was made for `lD` (the date-tamper
  entry does make raw requests, but for the date seam, not the limit seam).
- **Per-turn model prose** for the `lE` round-3 nudge turn was not captured (only that no controlled tool
  call resulted); tool arguments come from `ToolInvocation.argsJson`.
- **No production build**, no cluster/concurrency, no real banking rail — local single-process demo only.
- Other nodes' Vitest suites (`tests/unit`, `tests/scenarios`, `tests/app`, `tests/integration`) were not
  run by this node.

## Evidence map

| Path | Content |
| --- | --- |
| `output/playwright/live/REPORT-lD-round{1,2,3}.md` | per-round lD: prompts, tool calls, gate rows, DB numbers, screenshots |
| `output/playwright/live/lD-round{1,2,3}/*.png` | new virtual card, post-spend, over-limit refusal (per round) |
| `output/playwright/live/REPORT-lE-round{1,2,3}.md` | per-round lE: prompts, three tool calls, allowance continuity, DB numbers |
| `output/playwright/live/lE-round{1,2,3}/*.png` | replacement card, exhausted-allowance refusal (per round) |
| `output/playwright/live/REPORT-lA-lC-round{1,2}.md` | per-round combined regression: credit no-doubling, lC ledger/timestamp |
| `output/playwright/live/lA-lC-round{1,2}/*.png` | `/cards` after 补办, consume form, consume success, card tile |
| `output/playwright/REPORT-mock-suite.md` | mock suite: 23 journeys, exit code, DB file |
| `output/playwright/REPORT-date-tamper-boundary.md` | date-tamper: 9 cases, exact responses, DB file |
| `logs/` (gitignored) | raw per-run stdout, evidence JSON, DB dumps — never committed |
| `tests/e2e/screenshots/live/*.png` | earlier-run artefacts for live scenarios `0`–`7` (not re-run this cycle; kept unchanged, their provenance is in Git history) |

Per-round screenshots are copied into `lD-round<N>/` / `lE-round<N>/` / `lA-lC-round<N>/` because the
harness's fixed screenshot names are overwritten by the next run.
