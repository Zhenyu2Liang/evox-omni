# LIVE acceptance — virtual-card acceptance at the card-instant product tree

Real `LLM_MODE=live` model · real headless Chrome · real `next dev` · isolated DB per entry.
No mock, no response interception, no SDK/HTTP call standing in for a frontend action.

This file records the current state of the evidence only.
History lives in Git (`git log -p -- tests/e2e/LIVE-ACCEPTANCE-REPORT.md`).

## What each evidence set certifies

Card consumption's business month is now resolved at the same instant the monthly limit was enforced with
(`banking-sdk/card.ts`, `banking-sdk/card-family.ts`; `getCards` no longer leaks `Array#map`'s index as that
instant). Production still resolves that instant as `demoNow()`, so the observable behaviour must be unchanged.
The runs below are the proof, at the current HEAD, that it is unchanged.

| Evidence set | Certifies commit | Product tree | Verdict | Exit code |
| --- | --- | --- | --- | --- |
| `lD` round 2 (`REPORT-lD-head7a7a4d3-round2.md`) | `fa36508` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lE` round 2 (`REPORT-lE-head7a7a4d3-round2.md`) | `339c50b` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `date-tamper-boundary.e2e.ts` (`output/playwright/REPORT-date-tamper-boundary.md`) | `fa36508` | ≡ `7a7a4d3` | **PASS 8 / FAIL 0 / SKIP 1** | `0` |
| Mock suite `acceptance.e2e.ts` (`output/playwright/REPORT-mock-suite.md`) | `fa36508` | ≡ `7a7a4d3` | **PASS 23 / FAIL 0 / SKIP 0** | `0` |

Every set above is certified against the same product tree.
`git diff --stat 7a7a4d3 HEAD -- banking-sdk agent security planner lib app components prisma scripts` → empty output,
so the four sets together certify the card-instant product tree regardless of which evidence-only commit was HEAD
when each ran (`git diff --name-only 7a7a4d3 HEAD` lists evidence reports and PNGs only).

`lD` round 1 and `lE` round 1 are kept as separate rounds in this same product tree.
Their printed summary line was `PASS 1 / FAIL 0 / SKIP 0` each, but their `EXIT=` line was produced by the
`%ERRORLEVEL%` method below, which is proven not to carry a child's exit code — so round 1 does **not** certify
an exit code. Round 2 re-ran the identical assertions in a fresh process with a proven capture, and is the round
whose exit code counts. Nothing was deleted or weakened to reach a green round.

## How "live" is proven

- `.env.local` supplies `LLM_MODE=live` / `LLM_PROVIDER=deepseek` / `LLM_MODEL=deepseek-flash` /
  `DEEPSEEK_API_KEY` (gitignored; presence-only — the value is never printed, echoed or committed).
- `/api/health` → `{"ok":true,"data":{"status":"ok","time":…,"llmMode":"live"}}` on the booted app, every run.
- Resolved model id read from persisted `AgentRunEvent(eventType='provider_request_payload').payloadJson.payload.model`
  → `deepseek-flash`; `LIVE_FORCE_MODEL` unset, so `.env.local`'s id is used unchanged.
- Every business write carries a gateway `PendingAction` (RED, `requiresMfa=true`) and an `MfaChallenge` row;
  the code `123456` was typed into the real MFA card in the real browser.
- `prisma/live-acceptance.db` is reprovisioned per run (`db push` → probe → `tsx prisma/seed.ts`).
  Never `dev.db` / `test.db`, never a user backup, never a `.env.local` edit.

## Exit-code measurement (harness invariant)

Two independent signals are required per run, and a printed `PASS` with a non-zero exit code is a FAILURE.

- Signal 1 — the tool-reported process exit code, obtained with `; exit $LASTEXITCODE` after the native command.
- Signal 2 — an `EXIT=` line appended to the log with delayed expansion (`cmd /v:on`, `!ERRORLEVEL!`) and the code
  propagated with `exit !EC!`.

The `cmd /c "…"` + separate `cmd /c "echo EXIT=%ERRORLEVEL%"` form is invalid: `%ERRORLEVEL%` expands at parse
time, so it reports the value from before the program ran. Both round-2 reports carry control experiments proving
the adopted method reports `7` for `process.exit(7)` (and `0` for `process.exit(0)`), and that the discarded method
reports `0` for the same `exit 7` program.

## `lD` — virtual card apply + monthly-limit enforcement

Command per round (separate process, scenario selection only through `LIVE_SCENARIOS`):

```powershell
$env:LIVE_SCENARIOS='lD'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lD-head-round2.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lD-head-round2.log & exit !EC!"; exit $LASTEXITCODE
```

Round 2: `EXIT=0`, tool exit code `0`, `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`.
Port `51027`, dev-server pid `30688`, Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`.

**Prompt actually sent** (turn 1; no nudge or continuation consumed):

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

The consume and over-limit legs are pure `/cards` dialog submissions — **0 model turns**.

**Model behaviour**: `describe_turn {"purpose":"operation","operations":["apply_virtual_card"]}` →
`apply_virtual_card {"monthlyLimit":"100.00"}`, invocation `completed`, `attempt=1`.

**Panel reality**: one real panel — `PendingAction` `toolName=apply_virtual_card`, `riskLevel=RED`,
`requiresMfa=true`, `status=executed`; `MfaChallenge` code `123456`, `attempts=0/3`, `verified`.
No clarification, no nudge, no timeout, and `assertNoFabricatedConfirmationPanel` never fired.

**Raw `Card` row**: `type=VIRTUAL`, `status=ACTIVE`, `network=UnionPay`, `monthlyLimitMinor=10000`,
`linkedAccountId=acct_checking`, `creditLimitMinor=null`, `availableLimitMinor=null`.
Card id `cardidem_c9d4e2a18b5823d8e71913e140f25b13`, mask `****1418`.
`/cards` renders 账户可用余额 / 当前可支付金额 only — no 信用额度 / 可用额度 anywhere.

**Money movement** (round 1 → round 2):

| Item | Round 1 | Round 2 |
| --- | --- | --- |
| Checking balance minor | `2358000` → `2355000` | `2358000` → `2355000` |
| New `channel=CARD` / `direction=DEBIT` `Transaction` | `cmvc08e0h005djsf8lhgjfku3` (−`3000`) | `cmvc12d8j004114f8o26zpzup` (−`3000`, merchant `虚拟卡开卡消费验证`) |
| New `CardConsumption` | `cmvc08e0i005ejsf879h6985o` (`3000`) | `cmvc12d8k004214f8864larvi` (`3000`) |
| Server-projected payable | `100.00` → `70.00` | `100.00` → `70.00` |
| Over-limit `80.00` | `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。` / screen `超出本月消费限额`, payable stays `70.00`, zero funds/ledger/consumption movement | same; merchant rows in `Transaction` and `CardConsumption` = `0` |

`Transaction.occurredAt` = `CardConsumption.occurredAt` = `2026-09-25T04:00:00.000Z` (`demoNow()`).
The `apply_virtual_card` receipt's `resultJson.card.payableAmount` is `"70.00"` — the enforced month's remainder,
i.e. the snapshot resolves the month at the enforced instant.
Payable is the server projection `min(account available cash, remaining monthly allowance)`, not a model-invented number.

## `lE` — 挂失 → 补办 → consume on the new card

Command per round: `$env:LIVE_SCENARIOS='lE'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`.
Round 2: `EXIT=0`, tool exit code `0`, `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`.
Port `52744`, dev-server pid `14572`.

**Prompts actually sent** (each leg resolved on turn 1; no nudge needed):

```
开卡 : 请帮我新开一张虚拟卡，月消费限额设为100元
挂失 : 我刚才新办的那张虚拟卡（尾号4977，月限额100元）丢失了，请帮我正式挂失这张卡
补办 : 请为我刚才挂失的虚拟卡（原卡尾号4977）补办一张新卡
```

The tail `4977` is the mask the harness had just created — no invented data.
Round 1 used its own real tail (`5706`).

**Tool calls** (all `completed`, `origin=pi`, `operationKey` == the matching `PendingAction.id`):
`apply_virtual_card {"monthlyLimit":"100.00"}` → `report_lost_card {"cardId":"<source>","reason":"用户报告卡片遗失，要求正式挂失"}`
→ `replace_card {"cardId":"<source>"}`.

**Panel reality**: three `PendingAction` rows (`riskLevel=RED`, `requiresMfa=true`, `status=executed`) each with one
`MfaChallenge` (`123456`, `attempts=0/3`, `verified`). No wrong code, no lock, no re-prompt, no fabricated-panel claim.

**Raw `Card` cross-check**:

- Source `cardidem_b0aeb5ece9b12e0edec896d1323b239f` (`****4977`) stays terminal `LOST` with
  `replacedByCardId=cmvc1boyz00emvof8fi5avmcs`; the 挂失 leg moved **zero** funds.
- **Exactly one** new `VIRTUAL` / `ACTIVE` card (`****0148`, ≠ `****4977`) with
  **`linkedAccountId=acct_checking` inherited** from the source, `monthlyLimitMinor=10000`,
  `creditLimitMinor` / `availableLimitMinor` null.
- **Monthly allowance continues, never resets**: `100.00` (apply) → `70.00` (after the `30.00` pre-lost spend) →
  **`70.00` after 补办** (rendered `当前可支付金额 = ¥70.00`, the `100.00` reset explicitly excluded) → `0.00`
  (after the `70.00` spend) → `0.00` (after a refused `1.00`).
- Pre-lost spend on the source: `Transaction` `cmvc1bi5w0041vof86pezrbir` (−`3000`) +
  `CardConsumption` `cmvc1bi5x0042vof8t9lxd5yz` (`3000`), balance `2358000` → `2355000`.
- Spend on the replacement, exactly once: `channel=CARD` / `direction=DEBIT` `Transaction`
  `cmvc1bq4f00f2vof8dqr5jryd` (−`7000`) + `CardConsumption` `cmvc1bq4g00f3vof8fkqbg3jx` (`7000`),
  balance `2355000` → `2348000`.
- Refused `1.00` after exhaustion (`虚拟卡超限拒绝验证`): `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。`,
  screen `超出本月消费限额`, zero `Transaction`, zero `CardConsumption`, balance unchanged, payable `0.00`.
- Available credit does not double: the only non-`LOST` `CREDIT` row is `card_credit` (`1800000` minor = ¥18,000.00);
  the `LOST` source contributes nothing and no virtual card carries credit fields.

Round 1 numbers are the same shape (`REPORT-lE-head7a7a4d3-round1.md`): source `****5706` → `LOST`,
replacement `****8108`, continuity `100.00` → `70.00` → `70.00` → `0.00`, balance `2358000` → `2355000` → `2348000`,
three panels all backed by real rows.

Both consumption rows carry `occurredAt=2026-09-25T04:00:00.000Z`; no request body sent an `occurredAt`.

## Date-tampering boundary — a separate entry from the browser flows

`tests/e2e/date-tamper-boundary.e2e.ts` sends raw HTTP to the running app against **its own isolated DB
`prisma/live-acceptance-date-tamper.db`** (≠ `e2e.db` / `test.db` / `dev.db`), with no model, no browser and no DOM.
It is deliberately a different entry from `live-acceptance.e2e.ts`: nothing in it is a frontend-interaction
assertion, and no browser scenario asserts a forged timestamp.

`pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts` → `SUMMARY cases=9 pass=8 fail=0 skip=1 → exit code 0`.

The forged-date repro, replayed end-to-end: create a VIRTUAL card with monthly limit `100.00` through the real routes
(`POST /api/cards` → `POST /api/cards/changes/[id]/verify` with `{"code":"123456"}`) → consume `10.00` normally →
`POST /api/cards/[id]/consume` with `90.00` and a **previous-month** `occurredAt` (`2026-08-01T04:00:00.000Z`) →
**`400`** `{"ok":false,"error":{"code":"VALIDATION","message":"Consumption time is server-owned: 'occurredAt' must not be sent"}}`
with **zero** movement (balance `23570.00` unchanged, consumption count `1`, month total `10.00`, `forgedAmountRows=0`)
→ consume `1.00` normally → **month booked total exactly `11.00`**.

The same refusal with the same zero side effects holds for a future date (`2026-12-24T04:00:00.000Z`),
a malformed date (`"not-a-date"`) and `occurredAt: null`.
Payable afterwards `89.00 = min(23569.00, 100.00 − 11.00)`.

Honest **SKIP**: `x1-model-seam-http` — the model-facing refusal in `agent/tools/card.ts`
(`消费入账时间由服务端决定`) is not reachable over HTTP (no route turns arbitrary tool arguments into a
`PendingAction`), so only the HTTP route contract is proven.

## Mock suite (kept green)

`pnpm exec tsx tests/e2e/acceptance.e2e.ts` → `== 汇总：PASS 23 ｜ FAIL 0 ｜ SKIP 0 ==`, exit code `0`,
`prisma/e2e.db`, real headless Chrome, `LLM_MODE=mock`.
Notable coverage: `b-transfer-mfa` wrong code → `验证失败，已尝试 1 次` with the card retained and no movement;
`j-circuit-breaker-lock` three wrong codes lock the owner across a reload; `f-wedge-refresh-recover` settles the
receipt exactly once; `h-investment-flow` `−1000.00` DEBIT / `+6178.36` CREDIT.

## NOT verified by these runs

- **Live scenarios not re-run at this product tree**: `lA`, `lB`, `lC` and live ids `0`–`15`, `2p`, `7`.
  Nothing here certifies them against the card-instant tree.
- **Model-facing date refusal** (`agent/tools/card.ts`, SKIP `x1`) — not reachable over HTTP; the boundary entry
  proves the route contract only.
- **MFA wrong-code / circuit-breaker paths under the live model** — every live leg submitted only the correct code
  (`attempts=0/3`); the mock suite covers the lock path, not the live model.
- **`lE` post-补办 available credit** was derived from RAW `Card` rows (sum of non-`LOST` `CREDIT` limits),
  not from a dashboard API read.
- **`lD` over-limit HTTP status** was read from the harness network log (`[4xx/5xx] POST 422 … LIMIT_EXCEEDED`)
  plus the on-screen `role="alert"` text; no independent raw-HTTP repro was made for the limit seam.
- **Single round per scenario** — one independent process each for `lD` and `lE` at this tree.
  A single green round does not prove long-run model stability.
- **No production build** (`next build`), no cluster/concurrency, no real banking rail — local single-process demo only.
- Other nodes' Vitest suites (`tests/unit`, `tests/scenarios`, `tests/app`, `tests/integration`) were not run by this node.

## Evidence map

| Path | Content |
| --- | --- |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round2.md` | lD round 2: commit certified, exit-code controls, prompt, tool calls, gate rows, DB numbers, screenshots |
| `output/playwright/live/REPORT-lE-head7a7a4d3-round2.md` | lE round 2: same, plus three panels and allowance continuity |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round1.md`, `…-lE-…-round1.md` | round-1 reports (printed PASS; exit signal not certifiable) |
| `output/playwright/live/lD-head7a7a4d3-round{1,2}/*.png` | new virtual card, post-spend, over-limit refusal (3 per round) |
| `output/playwright/live/lE-head7a7a4d3-round{1,2}/*.png` | replacement card with `当前可支付金额 ¥70.00`, exhausted-allowance refusal (2 per round) |
| `output/playwright/REPORT-mock-suite.md` | mock suite: 23 journeys, exit code, DB file |
| `output/playwright/REPORT-date-tamper-boundary.md` | date-tamper: 9 cases, exact responses, DB file |
| `output/playwright/live/REPORT-l{A,B,C}-*.md`, `REPORT-lA-lC-round{1,2}.md` | earlier-cycle per-scenario reports (their provenance is in Git history) |
| `logs/` (gitignored) | raw per-run stdout, evidence JSON, DB dumps, exit-code controls — never committed |

Per-round screenshots live in `…-round<N>/` directories because the harness's fixed screenshot names are overwritten
by the next run.
