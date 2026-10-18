# LIVE acceptance — virtual-card, card-consumption and card-loss → replace evidence

Real `LLM_MODE=live` model · real headless Chrome · real `next dev` · isolated DB per entry.
No mock, no response interception, no SDK/HTTP call standing in for a frontend action.

This file records the current state of the evidence only.
History lives in Git (`git log -p -- tests/e2e/LIVE-ACCEPTANCE-REPORT.md`).

## What each evidence set certifies

Card consumption's business month is resolved at the same instant the monthly limit was enforced with
(`banking-sdk/card.ts`, `banking-sdk/card-family.ts`; `getCards` no longer leaks `Array#map`'s index as that
instant). Production resolves that instant as `demoNow()`, so the observable behaviour must be unchanged.
The `lD`/`lE` runs are the proof that it is unchanged at `7a7a4d3`'s product tree.

`replace_card` is an agent capability for a `LOST` card of any type: the security gateway parks it as a real
`PendingAction` with `riskLevel=RED` / `requiresMfa=true` **before any card row exists**, and it executes only
after a real MFA submission. `manual_add_card` / `manual_delete_card` stay manual-only, and that restriction covers
creating a brand-new physical card and deleting a card record — not replacing a card that is already `LOST`.
The `lF`/`lG` runs are the proof at the current HEAD's product tree.

| Evidence set | Certifies commit | Product tree | Verdict | Exit code |
| --- | --- | --- | --- | --- |
| `lF` round 1 (`REPORT-lF-head15de129f-round1.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lF` round 2 (`REPORT-lF-head89d82441-round2.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lF` round 3 (`REPORT-lF-headdedee51d-round3.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 3 (`REPORT-lG-headacebc393-round3.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 4 (`REPORT-lG-head6a20dd93-round4.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 7 (`REPORT-lG-headd1cccd00-round7.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 8 (`REPORT-lG-headd1cccd00-round8.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lD` round 3 (`REPORT-lD-head7a7a4d3-round3.md`) | `0c50e2f` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lE` round 3 (`REPORT-lE-head7a7a4d3-round3.md`) | `0c50e2f` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lD` round 2 (`REPORT-lD-head7a7a4d3-round2.md`) | `fa36508` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lE` round 2 (`REPORT-lE-head7a7a4d3-round2.md`) | `339c50b` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `date-tamper-boundary.e2e.ts` (`output/playwright/REPORT-date-tamper-boundary.md`) | `fa36508` | ≡ `7a7a4d3` | **PASS 8 / FAIL 0 / SKIP 1** | `0` |
| Mock suite `acceptance.e2e.ts` (`output/playwright/REPORT-mock-suite.md`) | `fa36508` | ≡ `7a7a4d3` | **PASS 23 / FAIL 0 / SKIP 0** | `0` |

The seven `lF`/`lG` rows certify the current HEAD's product tree:
`git diff --stat d1cccd00 HEAD -- banking-sdk agent security planner lib app components prisma scripts` → empty output,
and the same command is empty for every round head (`15de129f`, `89d82441`, `dedee51d`, `a65fd5e2`, `1c674005`,
`acebc393`, `6a20dd93`, `3c5fe83e`, `d1cccd00`). One product tree therefore carries all seven certified rounds,
regardless of which evidence-only commit was HEAD when each ran. Evidence commit for these reports: `573fe009`.

The remaining rows certify `7a7a4d3`'s product tree:
`git diff --stat 7a7a4d3 <each evidence commit> -- banking-sdk agent security planner lib app components prisma scripts`
→ empty for `0c50e2f`, `fa36508` and `339c50b`. Product paths have changed between `7a7a4d3` and the current HEAD
(`agent/tools/card.ts`, `agent/system-prompt.ts`, `agent/messages/conversation.zh-CN.json`,
`agent/providers/mock/conversation-guidance.ts`), so those rows do not extend to the current HEAD; only a re-run on
this tree would.

`lD` round 1 and `lE` round 1 are kept as separate rounds in this same product tree.
Their printed summary line was `PASS 1 / FAIL 0 / SKIP 0` each, but their `EXIT=` line was produced by the
`%ERRORLEVEL%` method below, which is proven not to carry a child's exit code — so round 1 does **not** certify
an exit code. Rounds 2 and 3 re-ran the identical assertions, each in its own fresh process against a
re-provisioned database and a proven capture; those are the rounds whose exit codes count.
Nothing was deleted or weakened to reach a green round.

**Certified rounds per flow at this product tree** — `lD`: 3 executed, 2 exit-certified (rounds 2 and 3);
`lE`: 3 executed, 2 exit-certified (rounds 2 and 3). Each round is an independent process, browser and
re-provisioned SQLite file, so the three rounds are independent of one another rather than replays.

`lF`: 3 executed, 3 exit-certified (rounds 1, 2 and 3, each `0` on both signals).
`lG`: 8 executed, 4 exit-certified (rounds 3, 4, 7 and 8, each `0` on both signals).
`lG` rounds 1, 2, 5 and 6 carry no certification: rounds 1 and 2 lost their stdout before it was captured
(neither exit code, summary line nor DB number is preserved, and round 2 has no screenshots), and rounds 5 and 6
ended in the harness rather than in a product or model assertion. No assertion was weakened, skipped or deleted to
reach a green round. Full per-round table, FAIL causes and the turn-by-turn replay:
`output/playwright/live/REPORT-lF-lG-acceptance-summary.md`.

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
time, so it reports the value from before the program ran. Every round-2 and round-3 report carries control
experiments proving the adopted method reports `7` for `process.exit(7)` (and `0` for `process.exit(0)`), and that
the discarded method reports `0` for the same `exit 7` program.

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

### `lD` round 3 (`0c50e2f`, product tree ≡ `7a7a4d3`)

Fresh process, fresh `prisma/live-acceptance.db`, same real browser:

```powershell
$env:LIVE_SCENARIOS='lD'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lD-head-round3.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lD-head-round3.log & exit !EC!"; exit $LASTEXITCODE
```

Both signals: tool-reported process exit code `0`, log line `EXIT=0`.
Summary `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`, wall clock `38.55 s`, port `55343`, dev-server pid `58284`.

**Prompt actually sent** (turn 1; zero nudges, zero continuations): `请帮我新开一张虚拟卡，月消费限额设为100元`.
The consume and over-limit legs are pure `/cards` dialog submissions — 0 model turns.

**Raw `Card` row**: `cardidem_974723860f5e22adc06772726460e218`, `type=VIRTUAL`, `status=ACTIVE`,
`network=UnionPay`, `numberMasked=****2003`, `monthlyLimitMinor=10000`, `linkedAccountId=acct_checking`,
`creditLimitMinor=null`, `availableLimitMinor=null`, `replacedByCardId=null`.

**Money movement**: checking balance `2358000` → `2355000`;
`channel=CARD` / `direction=DEBIT` `Transaction` `cmvc1o8o200418sf8ixspw918` (−`3000`, merchant `虚拟卡开卡消费验证`) +
`CardConsumption` `cmvc1o8o300428sf8cdofet99` (`3000`). Rendered tile rows:
after apply `{"账户可用余额":"¥23,580.00","当前可支付金额":"¥100.00"}`, after spend
`{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}`; dialog summary
`{"关联账户":"****8821","账户可用余额":"¥23,580.00","月限额":"¥100.00","当前可支付金额":"¥100.00"}`.
Over-limit `80.00` → HTTP `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。`, on-screen `超出本月消费限额`,
payable stays `70.00`, zero balance / `Transaction` / `CardConsumption` movement.

**Gate-row caveat for this round**: the isolated DB is reprovisioned by the next run, and `lE` round 3 ran
afterwards against the same file, so `lD`'s own `PendingAction` / `MfaChallenge` / `ToolInvocation` rows are no
longer dumpable. Nothing was invented to fill the gap: this round's panel facts rest on the scenario's enforced
assertions plus its PASS evidence line (`MFA 123456 → 新虚拟卡 …`), with `lE`'s dumped rows as corroboration only.
Rounds 1–2 own their dumped gate rows.

**Screenshots** (`output/playwright/live/lD-head7a7a4d3-round3/`): `01-lD-new-virtual-card.png`,
`02-lD-after-spend.png`, `03-lD-over-limit-refusal.png`.

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

### `lE` round 3 (`0c50e2f`, product tree ≡ `7a7a4d3`)

Separate process after `lD` round 3 (shared test DB must never overlap), same proven capture:

```powershell
$env:LIVE_SCENARIOS='lE'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lE-head-round3.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lE-head-round3.log & exit !EC!"; exit $LASTEXITCODE
```

Both signals: tool-reported process exit code `0`, `EXIT=0`; summary `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`,
`49.08 s`, port `64156`, dev-server pid `43036`.

**Prompts actually sent** (each leg resolved on turn 1, no nudge):

```
开卡 : 请帮我新开一张虚拟卡，月消费限额设为100元
挂失 : 我刚才新办的那张虚拟卡（尾号4348，月限额100元）丢失了，请帮我正式挂失这张卡
补办 : 请为我刚才挂失的虚拟卡（原卡尾号4348）补办一张新卡
```

Tail `4348` is the mask the harness had just created — no invented data.

**Tool calls** (all `completed`, `attempt=1`, `origin=pi`): `describe_turn apply_virtual_card` →
`apply_virtual_card {"monthlyLimit":"100"}` → `describe_turn report_lost_card` → `get_cards {}` →
`report_lost_card {"cardId":"<source>","reason":"用户表示虚拟卡（尾号4348）丢失，申请正式挂失"}` →
`describe_turn replace_card` → `replace_card {"cardId":"<source>"}`.

**Panel reality** (`logs/live-round3-db.json`): three `PendingAction` rows, `riskLevel=RED`, `requiresMfa=true`,
`status=executed`, `argsJson` normalized (`apply_virtual_card` → `{"monthlyLimit":"100.00"}`); three `MfaChallenge`
rows, code `123456`, `attempts=0/3`, `status=verified` (`verifiedAt` `06:58:22.594Z`, `06:58:35.682Z`,
`06:58:38.851Z`).

**Raw `Card` cross-check**:

- Source `cardidem_a0bf16b0dc3c770b43a656c69da38384` (`****4348`) → `LOST`,
  `replacedByCardId=cmvc1pci500gl6kf8xwue5yfy`.
- Replacement `cmvc1pci500gl6kf8xwue5yfy` (`****5448`) `VIRTUAL` / `ACTIVE`, `monthlyLimitMinor=10000`,
  **`linkedAccountId=acct_checking` inherited** from the source, credit fields null.
- Allowance continuity: `100.00` → `70.00` → **`70.00` after 补办** → `0.00` → `0.00` (refused `1.00`).
- Pre-lost `30.00` spend: `Transaction` `cmvc1p2jh00456kf8rhwxniug` (−`3000`) + `CardConsumption`
  `cmvc1p2ji00466kf8u4ze9cfs` (`3000`, `cardId`=source), balance `2358000` → `2355000`.
- Post-补办 `70.00` spend on the new card, exactly once: `Transaction` `cmvc1pdn700h16kf8yu8422d2` (−`7000`) +
  `CardConsumption` `cmvc1pdn800h26kf8biovrmpp` (`7000`, `cardId`=replacement), balance `2355000` → `2348000`.
- Exactly **2** `CardConsumption` rows in total, distinct `executionKey`s (`63f9e331-…`, `747632fd-…`), both
  `occurredAt=2026-09-25T04:00:00.000Z`; no request body carried `occurredAt`.
- Refused `1.00` after exhaustion → `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。`, zero
  `Transaction` / `CardConsumption`, balance unchanged.
- Available credit not doubled: the only non-`LOST` `CREDIT` row is `card_credit` (`1800000` = ¥18,000.00).

**Screenshots** (`output/playwright/live/lE-head7a7a4d3-round3/`): `01-lE-replacement-card.png`,
`02-lE-exhausted-refusal.png`.

## `lF` — credit 挂失 → 补办 in a new session

Scenario id `lF` (`lF-live-credit-report-lost-and-replace-new-session`), selected with `$env:LIVE_SCENARIOS='lF'`.
Two model legs, each resolving on its first turn — no nudge and no continuation budget spent:

```
挂失 : 我的尾号6688信用卡丢失了，请正式挂失，我确认不可撤销。
补办 : 请为刚挂失的尾号6688信用卡补办新卡。
```

Both legs are RED: `report_lost_card {"cardId":"card_credit",…}` and `replace_card {"cardId":"card_credit"}` each
persist a `PendingAction` (`riskLevel=RED`, `requiresMfa=true`) plus one `MfaChallenge` (`123456`, `attempts=0/3`,
`verified`). While `replace_card` waits, `GET /api/cards` still reports `cardCount=3`, `sourceStatus=LOST`,
`sourceReplacedByCardId=null`, `newlyCreatedCardIds=[]` — the park creates no card and changes no status; only the
MFA submission produces the replacement.

**Round 3 raw rows** (`REPORT-lF-headdedee51d-round3.md`): source `card_credit` stays `CREDIT`/`LOST`,
`numberMasked=****6688`, `replacedByCardId=cmve0pkb700b2ugf8qcnl4km9`; the replacement
`cmve0pkb700b2ugf8qcnl4km9` is `CREDIT`/`ACTIVE`, `numberMasked=****4485` (a new number),
`creditLimitMinor`/`availableLimitMinor` = `1800000`/`1800000` inherited unchanged; card count `3 → 4`.
Rounds 1 and 2 show the same shape with `****3613` (`cmve04n3r00b2v0f89am4wwf4`) and `****7720`
(`cmve0n2z1009ufof84bgdlc5k`).

**Available credit is counted once**: the non-`LOST` `CREDIT` available total is `18000.00` before and after the
replacement; the naive total over all `CREDIT` rows including the `LOST` source is `36000.00` and is explicitly
excluded as the bug signature. `/cards` renders it per tile — the replacement tile shows `信用额度 ¥18,000.00` /
`可用额度 ¥18,000.00`, while the `LOST` source tile still renders `可用额度 ¥18,000.00` and is not summed.

**No money moves**: dashboard `23580.00` → `23580.00`, `GET /api/bills` added `0` / removed `0`, `Transaction`
rows `232` before and after, `CardConsumption` rows `0`.

**Model identity** comes from persisted rows, not only from health:
`AgentRunEvent(eventType='provider_request_payload')` → `payloadJson.payload.model` = `deepseek-flash` for every
payload row (round 3: 6 rows, `unparsablePayloads=0`, `payloadsWithoutPayloadModel=0`; round 2: 5 rows).
Round 1's extractor printed `model counts=[]` and carries no row evidence, so round 1's model identity rests on
`/api/health` `llmMode:"live"` plus the harness header.

## `lG` — full card-loss → replace chain in one session

Scenario id `lG` (`lG-live-full-card-loss-replace-chain-single-session`), selected with `$env:LIVE_SCENARIOS='lG'`.
One chat session drives six verbatim prompts (`MAX_TURNS_PER_LEG=6` natural turns per write leg), with the two
front-end `/cards` consume legs interleaved at **0** model turns:

```
1 请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。
2 尾号<mask>的虚拟卡信息泄露，请正式挂失，我确认不可撤销。
3 请为刚才正式挂失的尾号<mask>虚拟卡再补办一张新卡。
4 尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。
5 请为刚挂失的尾号6688信用卡补办新卡。
6 确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。
```

`<mask>` is the last four digits of the card prompt 1 actually created (round 7 `****1865`, round 8 `****3433`),
derived at runtime — never an invented number.

**Turn 5 is the capability proof**: it produces a real `replace_card {"cardId":"card_credit"}` and a RED MFA panel,
and no assistant turn in rounds 3–8 answers it with 「补办实体信用卡和借记卡只能在「卡片」页面手动办理」.
**Turn 6 is accepted in two shapes and never grows the card count**: round 7 answered prose-only (`describe_turn` +
`get_cards`, `finalTurn.action === undefined`, `6 → 6`); round 8 re-emitted `replace_card`, parked a second
`PendingAction`, rendered a real panel, and replayed the existing replacement instead of issuing a second card —
the same `commandDigest 14fc01beedc9156bb968b4e743dc79231f75ee172248e4fa3b7429bd8338cb6d`, the same replacement
card `cmve4oa9d00rc50f8njjc711f`, `cardCountBefore=6` / `cardCountAfter=6`, `mfaCompleted=true`.

**Virtual leg** (rounds 7/8 shape): the new `VIRTUAL`/`ACTIVE` card inherits `linkedAccountId=acct_checking` and
`monthlyLimitMinor=10000`, with `creditLimitMinor`/`availableLimitMinor` null. Source and replacement share one
monthly allowance, so it never resets on 补办: payable `100.00` → `70.00` (after the `30.00` spend) → **`70.00`
after the replacement** → `0.00` (after the `70.00` spend), and the following `1.00` is refused
`422 LIMIT_EXCEEDED` `超过虚拟卡月限额。` with zero financial movement.

**Credit leg**: source `card_credit` stays `CREDIT`/`LOST` with `replacedByCardId` pointing at the single new
`CREDIT`/`ACTIVE` card (`****8718` / `cmve4i4c300o6b4f8cqjdvnrp` in round 7; `****0495` /
`cmve4oa9d00rc50f8njjc711f` in round 8), which inherits `1800000`/`1800000`. The non-`LOST` `CREDIT` available
total stays `18000.00`; the naive all-`CREDIT` `36000.00` is excluded as the bug signature.

**Money moves only through consumptions**: `acct_checking.balanceMinor` `2358000` → `2355000` → `2348000`;
exactly two new `channel=CARD` / `direction=DEBIT` `Transaction` rows (−`3000` 虚拟卡开卡消费验证, −`7000`
虚拟卡补办续限验证) and exactly two `CardConsumption` rows — `3000` attributed to the **source** card and `7000`
to the replacement, so historical attribution is never re-pointed. `GET /api/bills` added `2` / removed `0`.
No request body carried `occurredAt`; both rows are server-stamped `2026-09-25T04:00:00.000Z` (`demoNow()`).
A 补办 itself moves no money.

Card counts are derived from the scenario's own start-of-run `GET /api/cards` baseline, never a hardcoded total:
`3 → 4` (virtual source) `→ 4` (`LOST`) `→ 5` (virtual replacement) `→ 5` (credit `LOST`) `→ 6` (credit
replacement) `→ 6` (final turn).

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

- **Live scenarios with no certification at the current HEAD's product tree**: `lA`, `lB`, `lC`, `lD`, `lE`
  (`lD`/`lE` certify `7a7a4d3`'s tree only) and live ids `0`–`15`, `2p`, `7`. `lF`/`lG` certify the current HEAD's
  product tree; nothing here extends to a sibling scenario.
- **`lG` rounds 1 and 2 are not preserved**: their exit code, summary line, duration, model-id rows and DB numbers
  exist nowhere, and round 2 has no screenshots. Both reports are labelled post-hoc reconstructions and certify
  nothing.
- **`lG` rounds 5 and 6 carry no summary line and no `-evidence.json`** — the process ended inside the
  `unhandledRejection` handler, so their business legs are corroborated by the post-run DB dump only.
- **`lF`'s "dashboard API + page do not double count the old card" is asserted per non-`LOST` `CREDIT` tile** —
  `app/cards/page.tsx` renders no page-level aggregate of available credit, so a page-level assertion has nothing to
  attach to. Product gap, reported not fixed; the helper records it at
  `tests/e2e/card-replace-chain.e2e-helper.ts:194-195`.
- **`DEBIT` replacement is not exercised** by `lF`/`lG`; the "any type" claim rests on the type-neutral catalog entry
  plus the executed `CREDIT` and `VIRTUAL` legs.
- **The panel-claim negation rule is not proven by Vitest here** — its `tests/unit/panel-claim.test.ts` cases are
  backed in this evidence only by an executed standalone 64-case table run through `pnpm exec tsx`.
- **Model-facing date refusal** (`agent/tools/card.ts`, SKIP `x1`) — not reachable over HTTP; the boundary entry
  proves the route contract only.
- **MFA wrong-code / circuit-breaker paths under the live model** — every live leg submitted only the correct code
  (`attempts=0/3`); the mock suite covers the lock path, not the live model.
- **`lE` post-补办 available credit** was derived from RAW `Card` rows (sum of non-`LOST` `CREDIT` limits),
  not from a dashboard API read.
- **`lD` over-limit HTTP status** was read from the harness network log (`[4xx/5xx] POST 422 … LIMIT_EXCEEDED`)
  plus the on-screen `role="alert"` text; no independent raw-HTTP repro was made for the limit seam.
- **Model stability is still not proven** — `lD`/`lE` ran 3 independent rounds each and `lF` 3, all passing, and
  `lG`'s turn 6 came out prose-only in round 7 and as a replayed `replace_card` in round 8; a finite number of
  rounds bounds non-determinism, it does not prove it absent over unlimited runs.
- **`lD` round 3 gate rows are not dumpable** — the run's `PendingAction` / `MfaChallenge` / `ToolInvocation` rows
  were destroyed by `lE` round 3 reprovisioning the same isolated DB. Rounds 1–2 own dumped rows; round 3's panel
  evidence comes from the scenario assertions and its PASS line only.
- **No production build** (`next build`), no cluster/concurrency, no real banking rail — local single-process demo only.
- Other nodes' Vitest suites (`tests/unit`, `tests/scenarios`, `tests/app`, `tests/integration`) were not run by this node.

## Evidence map

| Path | Content |
| --- | --- |
| `output/playwright/live/REPORT-lF-lG-acceptance-summary.md` | consolidated `lF`/`lG` deliverable: all 11 rounds, FAIL causes, exact commands + exit-code calibration, turn-by-turn replay, DB verification, unresolved list, evidence map, cleanup |
| `output/playwright/live/REPORT-lF-head{15de129f,89d82441,dedee51d}-round{1,2,3}.md` | `lF` rounds 1–3: certified head, dual exit signal, verbatim prompts, `PendingAction`/`MfaChallenge` rows, card table, per-tile credit check, ledger invariance |
| `output/playwright/live/REPORT-lG-head{acebc393,6a20dd93,d1cccd00}-round{3,4,7,8}.md` | `lG` certified rounds: full six-prompt chain, tool calls, panels, virtual + credit card rows, allowance continuity, DB facts, cleanup snapshot |
| `output/playwright/live/REPORT-lG-head{a65fd5e2,1c674005}-round{1,2}.md` | `lG` rounds 1–2, post-hoc reconstructions — no stdout, no exit code, no DB numbers (round 2 has no screenshots) |
| `output/playwright/live/REPORT-lG-head{6a20dd93,3c5fe83e}-round{5,6}.md` | `lG` rounds 5–6: verbatim failure line plus `EXIT=1`; no summary line, no `-evidence.json` |
| `output/playwright/live/lF-head*-round*/*.png` | `lF`: `/cards` after 挂失, `/cards` after 补办 (2 per round) |
| `output/playwright/live/lG-head*-round{1,3,4,5,6,7,8}/*.png` | `lG`: virtual replacement, exhausted-allowance refusal, credit replacement (3 per round; round 2 has none) |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round3.md` | lD round 3: commit certified, exit-code controls, prompt, tool calls, DB numbers, screenshots, gate-row caveat |
| `output/playwright/live/REPORT-lE-head7a7a4d3-round3.md` | lE round 3: same shape, plus three panels and allowance continuity |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round2.md` | lD round 2: commit certified, exit-code controls, prompt, tool calls, gate rows, DB numbers, screenshots |
| `output/playwright/live/REPORT-lE-head7a7a4d3-round2.md` | lE round 2: same, plus three panels and allowance continuity |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round1.md`, `…-lE-…-round1.md` | round-1 reports (printed PASS; exit signal not certifiable) |
| `output/playwright/live/lD-head7a7a4d3-round{1,2,3}/*.png` | new virtual card, post-spend, over-limit refusal (3 per round) |
| `output/playwright/live/lE-head7a7a4d3-round{1,2,3}/*.png` | replacement card with `当前可支付金额 ¥70.00`, exhausted-allowance refusal (2 per round) |
| `output/playwright/REPORT-mock-suite.md` | mock suite: 23 journeys, exit code, DB file |
| `output/playwright/REPORT-date-tamper-boundary.md` | date-tamper: 9 cases, exact responses, DB file |
| `output/playwright/live/REPORT-l{A,B,C}-*.md`, `REPORT-lA-lC-round{1,2}.md` | earlier-cycle per-scenario reports (their provenance is in Git history) |
| `logs/` (gitignored) | raw per-run stdout, evidence JSON, DB dumps, exit-code controls — never committed |

Per-round screenshots live in `…-round<N>/` directories because the harness's fixed screenshot names are overwritten
by the next run.
