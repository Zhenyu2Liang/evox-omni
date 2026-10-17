# LIVE acceptance round report - scenario lE

- **Scenario id**: lE
- **Scenario name**: lE-live-virtual-card-replace-continuity
- **Round**: 1 of 3
- **Harness**: tests/e2e/live-acceptance.e2e.ts
- **Exact command**: `$env:LIVE_SCENARIOS='lE'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
  (executed under `cmd /c "set LIVE_SCENARIOS=lE&& pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lE-round1.log 2>&1"` so stdout+stderr land in one UTF-8 log; the env var and the program are identical to the stated command)
- **Model**: REAL DeepSeek, `LLM_MODE=live`, model id **deepseek-flash** (the entry printed `Live run uses the configured model.` - no forced override; the scenario evidence JSON records `"model": "deepseek-flash"`)
- **Browser**: REAL headless Chrome - `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **Server**: REAL `next dev` on a free port (`http://localhost:54709`), `/api/health={"ok":true,...,"llmMode":"live"}`
- **Isolated DB**: `prisma/live-acceptance.db` (deleted, `prisma db push`, probe, `tsx prisma/seed.ts`; `prisma/dev.db` and `prisma/test.db` untouched)
- **No mock, no interception**: the only simulated part is the bank itself (SQLite).

## Verbatim result

```text
PASS lE-live-virtual-card-replace-continuity — lE 实际发送（开卡）：「请帮我新开一张虚拟卡，月消费限额设为100元」 → MFA 123456 → 新虚拟卡 cardidem_fc1096b884868b9d19d99577762cd1e5（monthlyLimitMinor=10000、linkedAccountId=acct_checking）；挂失前消费 30.00（购物/虚拟卡挂失前消费验证）= 新增 CARD/DEBIT 流水 -3000（cmvbytl49004ru8f8vd6b9c69）+ 1 条 CardConsumption（cmvbytl49004su8f8htkckuq7），活期余额 23580.00 → 23550.00；挂失实际发送：「我刚才新办的那张虚拟卡（尾号4715，月限额100元）丢失了，请帮我正式挂失这张卡」 → MFA 123456 → RAW status=LOST、资金零变化；补办实际发送：「请为我刚才挂失的虚拟卡（原卡尾号4715）补办一张新卡」 → MFA 123456 → cardidem_fc1096b884868b9d19d99577762cd1e5.replacedByCardId=cmvbytxml00lwu8f85jwfp6fe（恰新增 1 张 VIRTUAL/ACTIVE 卡）；补办卡 RAW：linkedAccountId=acct_checking（= 原卡 acct_checking，继承修复生效）、monthlyLimitMinor=10000、卡号 ****3915 ≠ 原卡 ****4715、无信用额度；家庭月限额连续：已用 3000 → payableAmount=70.00（=70.00，不是 100.00），卡片渲染 {"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}；补办卡消费 70.00（购物/虚拟卡补办续限验证）= 新增 CARD/DEBIT 流水 -7000（cmvbytys900mcu8f8e1wykxe5）+ 1 条 CardConsumption（cmvbytys900mdu8f8v89mxyhg），活期余额 23550.00 → 23480.00（恰扣一次）→ payableAmount=0.00；额度用尽后 1.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 0.00；截图 D:\projects\banking-agent\.genesis\workers\worker_T5_A37\output\playwright\live\01-lE-replacement-card.png / D:\projects\banking-agent\.genesis\workers\worker_T5_A37\output\playwright\live\02-lE-exhausted-refusal.png；证据 JSON D:\projects\banking-agent\.genesis\workers\worker_T5_A37\logs\lE-evidence.json
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

- **Process exit code**: **0** (recorded explicitly: `logs/lE-round1.exit.txt` -> `EXIT=0`)
- **Summary line** (verbatim above): `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` (parsed from the same log; a printed PASS with exit code 1 was treated as a FAIL condition, so both signals were asserted and both are green)
- **Verdict**: **PASS**

## Natural-language prompts actually sent (verbatim)

Only the FIRST prompt of each leg was needed - the real model parked the gated tool on that same turn.

| Leg | Turn 1 (sent) | Extra turns sent |
| --- | --- | --- |
| apply | `请帮我新开一张虚拟卡，月消费限额设为100元` | none |
| 挂失 (report lost) | `我刚才新办的那张虚拟卡（尾号4715，月限额100元）丢失了，请帮我正式挂失这张卡` | none |
| 补办 (replace) | `请为我刚才挂失的虚拟卡（原卡尾号4715）补办一张新卡` | none |

No internal tool name or parameter name was ever typed. The `4715` tail is the mask tail the harness itself created (`****4715`), so the request names a card the user really holds.

## Model tool calls observed (RAW DB rows, authoritative)

From `ToolInvocation` (model-side call + status) and `PendingAction` (gateway-parked action):

| # | tool | ToolInvocation.argsJson | ToolInvocation.status | invocation id (run / ordinal) | PendingAction.argsJson | riskLevel | requiresMfa | PendingAction.status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `apply_virtual_card` | `{"monthlyLimit":"100"}` | `completed` | `call_b93b40b6-2e30-4858-93f5-a965aeb5f489` (run `cmvbyteym0000u8f8ff2a0mft`, ordinal 2) | `{"monthlyLimit":"100.00"}` | `RED` | `true` | `executed` |
| 2 | `report_lost_card` | `{"cardId":"cardidem_fc1096b884868b9d19d99577762cd1e5","reason":"用户反馈卡片丢失，申请正式挂失"}` | `completed` | `call_2a464272-e010-49f4-816d-11597c4e6df1` (run `cmvbytlp1004tu8f80s2a6znz`, ordinal 4) | identical to the invocation args | `RED` | `true` | `executed` |
| 3 | `replace_card` | `{"cardId":"cardidem_fc1096b884868b9d19d99577762cd1e5"}` | `completed` | `call_2199947e-4059-43d2-9ef7-1b1fd8fc0fda` (run `cmvbyttno00gau8f8lont4704`, ordinal 2) | identical to the invocation args | `RED` | `true` | `executed` |

- `errorCode` = `null` and `attempt` = `1` on all three invocations (no retry, no failure).
- **`consume_virtual_card` ToolInvocation count = 0**: both consumes were made through the REAL `/cards` consume dialog (`POST /api/cards/<id>/consume`), i.e. the reader-facing frontend path, never a model tool call.
- Tool results show the allowance continuity: apply -> `payableAmount=100.00`; report_lost_card -> `payableAmount=70.00` (already 30.00 spent); replace_card -> `payableAmount=70.00` (**no reset to 100.00**).

## Confirmation / MFA panel

- A REAL confirmation/MFA panel appeared for every RED tool (the gateway persisted a `PendingAction`; `driveRedTool` detected the MFA card via `mfaCardPresent`). The model did NOT fabricate a panel: `helpers.ts#assertNoFabricatedConfirmationPanel` never had to fail, and `/api/actions` really had pending work.
- Each panel was completed by typing the simulator code `123456` once.
- `MfaChallenge` rows: **3** challenges, all `status=verified`, `attempts=0` (no wrong code), `consumedAt` set - so no retry, no lock, no terminal-lock path.

## Turn economy / nudges

- **No clarification, no nudge, no retry, no timeout** occurred. Every leg settled on its first natural turn (the remaining prompts in `VC_APPLY_TURNS` / `vcReportLostTurns` / `vcReplaceTurns` were never sent).
- `logs/lE-round1.log` contains no `等待 LIVE 模型调用受控工具` timeout and no panel-claim assertion failure.
- Network noise: exactly **1** 4xx - `POST /api/cards/cmvbytxml00lwu8f85jwfp6fe/consume -> 422 {"code":"LIMIT_EXCEEDED"}` - which is the DELIBERATE over-limit refusal asserted at the end of the scenario, not a defect. console error = 1 (same request), pageerror = 0.

## DB cross-check (prisma/live-acceptance.db, RAW rows)

Card rows (BigInt minor units; `user_liming`):

| id | type | status | numberMasked | monthlyLimitMinor | creditLimitMinor | availableLimitMinor | linkedAccountId | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| card_credit | CREDIT | ACTIVE | `****6688` | 1800000 | 1800000 | 1800000 | null | null |
| card_debit | DEBIT | ACTIVE | `****8821` | null | null | null | null | null |
| card_virtual | VIRTUAL | ACTIVE | `****7788` | 500000 | null | null | acct_checking | null |
| cardidem_fc1096b884868b9d19d99577762cd1e5 (SOURCE) | VIRTUAL | **LOST** | `****4715` | 10000 | null | null | acct_checking | cmvbytxml00lwu8f85jwfp6fe |
| cmvbytxml00lwu8f85jwfp6fe (REPLACEMENT) | VIRTUAL | **ACTIVE** | `****3915` | 10000 | null | null | acct_checking | null |

- Source card stays terminal **LOST** and points at its replacement (`replacedByCardId`).
- Exactly **ONE** new ACTIVE VIRTUAL card (`cmvbytxml00lwu8f85jwfp6fe`); the seed's 3 cards are untouched (5 rows total = 3 seeded + 1 LOST source + 1 replacement).
- `linkedAccountId` is **the SAME** (`acct_checking`) on source and replacement - the inheritance fix holds.
- Masked number is **NEW**: `****4715` -> `****3915`.
- `monthlyLimitMinor` continuous: `10000` on both (100.00 CNY).
- No credit fields on either virtual card (`creditLimitMinor`/`availableLimitMinor` = null) - it is a debit instrument.

Allowance progression (monthly remaining, never reset):

| Moment | payableAmount | Source |
| --- | --- | --- |
| after apply_virtual_card | **100.00** | apply tool result |
| after the 30.00 pre-lost consume | 70.00 | report_lost_card tool result |
| after replace_card | **70.00** (NOT 100.00) | replace_card tool result + rendered `当前可支付金额` = `¥70.00` |
| after the 70.00 consume on the NEW card | **0.00** | scenario assertion + `GET /api/cards` |
| after the refused 1.00 attempt | 0.00 | unchanged |

Exactly ONE real frontend consume on the NEW card, exactly once:

- `Transaction` **cmvbytys900mcu8f8e1wykxe5**: `amountMinor=-7000`, `direction=DEBIT`, `channel=CARD`, `category=购物`, `merchant=虚拟卡补办续限验证`, account `acct_checking`. No other new CARD/DEBIT row exists.
- `CardConsumption` **cmvbytys900mdu8f8v89mxyhg**: `cardId=cmvbytxml00lwu8f85jwfp6fe`, `accountId=acct_checking`, `amountMinor=7000`, `executionKey=363fcdb3-321c-40b0-9333-2e87fa4d022b`.
- Balance debited once: `acct_checking.balanceMinor` **2355000 -> 2348000** (23,550.00 -> 23,480.00 CNY); final RAW balance `2348000`.
- Pre-lost consume (on the SOURCE card, for the continuity proof): `Transaction` **cmvbytl49004ru8f8vd6b9c69** `amountMinor=-3000` + `CardConsumption` **cmvbytl49004su8f8htkckuq7** `amountMinor=3000`; balance `2358000 -> 2355000`. The 挂失 leg itself moved **no** funds.
- Refused 1.00 attempt (`虚拟卡超限拒绝验证`): zero `Transaction`, zero `CardConsumption`, unchanged balance; dialog text `超出本月消费限额`.

Credit-available total is NOT doubled: the only non-LOST `CREDIT` row is `card_credit` (`creditLimitMinor`/`availableLimitMinor` = 1800000 -> **18,000.00**), and the LOST source card is excluded by construction.

## Final on-page state

- `/cards` rendered the replacement tile with `账户可用余额 = ¥23,550.00` and `当前可支付金额 = ¥70.00` (no `信用额度`/`可用额度` rows).
- After the 70.00 consume the replacement's payable reads `¥0.00`; the final consume dialog attempt rendered the refusal `超出本月消费限额` with the balance unchanged.

## Screenshots (preserved per round)

Harness screenshots are written to the fixed live names and would be overwritten by the next round, so they were copied into a round folder:

- `output/playwright/live/lE-round1/01-lE-replacement-card.png` - REAL `/cards` page after 挂失 + 补办 (replacement card `****3915`, 当前可支付金额 `¥70.00`).
- `output/playwright/live/lE-round1/02-lE-exhausted-refusal.png` - the exhausted-allowance refusal dialog (`超出本月消费限额`).

## Not verified in this round

- The `creditAvailable` total was derived from the RAW `Card` rows (non-LOST CREDIT sum), not from a fresh `GET` of the dashboard summary after the run (the dev server had already been torn down).
- The entry does not persist a typed per-turn `AgentSession.stateJson` block list for this provider run, so the model's raw prose for each turn is not part of this evidence (the tool arguments above come from `ToolInvocation.argsJson`, which is authoritative).
- Whether a plain `确认` click preceded the MFA card on any leg is not recorded by the harness/DB; the persisted, provable gate is `PendingAction` + `MfaChallenge` (`verified`, `attempts=0`).
