# LIVE acceptance round report - scenario lE

- **Scenario id**: lE
- **Scenario name**: lE-live-virtual-card-replace-continuity
- **Round**: 2 of 3 (independent process, own DB reset, own dev server, own browser)
- **Harness**: tests/e2e/live-acceptance.e2e.ts
- **Exact command**: `$env:LIVE_SCENARIOS='lE'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
  (executed under `cmd /c "set LIVE_SCENARIOS=lE&& pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lE-round2.log 2>&1"` so stdout+stderr land in one UTF-8 log; env var and program identical)
- **Model**: REAL DeepSeek, `LLM_MODE=live`, model id **deepseek-flash** (entry printed `Live run uses the configured model.` - no forced override; scenario evidence JSON records `"model": "deepseek-flash"`)
- **Browser**: REAL headless Chrome - `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **Server**: REAL `next dev` pid 49912 on `http://localhost:62090`, `/api/health={"ok":true,...,"llmMode":"live"}`
- **Isolated DB**: `prisma/live-acceptance.db` (re-provisioned: delete -> `prisma db push` -> probe -> `tsx prisma/seed.ts`)
- **No mock, no interception**.

## Verbatim result

```text
PASS lE-live-virtual-card-replace-continuity — lE 实际发送（开卡）：「请帮我新开一张虚拟卡，月消费限额设为100元」 → MFA 123456 → 新虚拟卡 cardidem_c538003777f2d1483583d68daafac3a2（monthlyLimitMinor=10000、linkedAccountId=acct_checking）；挂失前消费 30.00（购物/虚拟卡挂失前消费验证）= 新增 CARD/DEBIT 流水 -3000（cmvbyxfty005gewf8nks7b1oh）+ 1 条 CardConsumption（cmvbyxfty005hewf8544l7b03），活期余额 23580.00 → 23550.00；挂失实际发送：「我刚才新办的那张虚拟卡（尾号0178，月限额100元）丢失了，请帮我正式挂失这张卡」 → MFA 123456 → RAW status=LOST、资金零变化；补办实际发送：「请为我刚才挂失的虚拟卡（原卡尾号0178）补办一张新卡」 → MFA 123456 → cardidem_c538003777f2d1483583d68daafac3a2.replacedByCardId=cmvbyxmlm00ieewf8dcowfq12（恰新增 1 张 VIRTUAL/ACTIVE 卡）；补办卡 RAW：linkedAccountId=acct_checking（= 原卡 acct_checking，继承修复生效）、monthlyLimitMinor=10000、卡号 ****9937 ≠ 原卡 ****0178、无信用额度；家庭月限额连续：已用 3000 → payableAmount=70.00（=70.00，不是 100.00），卡片渲染 {"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}；补办卡消费 70.00（购物/虚拟卡补办续限验证）= 新增 CARD/DEBIT 流水 -7000（cmvbyxntg00iuewf8fgn46cak）+ 1 条 CardConsumption（cmvbyxntg00ivewf8wmcugoit），活期余额 23550.00 → 23480.00（恰扣一次）→ payableAmount=0.00；额度用尽后 1.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 0.00；截图 D:\projects\banking-agent\.genesis\workers\worker_T5_A37\output\playwright\live\01-lE-replacement-card.png / D:\projects\banking-agent\.genesis\workers\worker_T5_A37\output\playwright\live\02-lE-exhausted-refusal.png；证据 JSON D:\projects\banking-agent\.genesis\workers\worker_T5_A37\logs\lE-evidence.json
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

- **Process exit code**: **0** (`logs/lE-round2.exit.txt` -> `EXIT=0`)
- **Summary line**: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`
- **Verdict**: **PASS** (both the printed PASS and the exit code were asserted)

## Natural-language prompts actually sent (verbatim)

| Leg | Turn 1 (sent) | Extra turns sent |
| --- | --- | --- |
| apply | `请帮我新开一张虚拟卡，月消费限额设为100元` | none |
| 挂失 (report lost) | `我刚才新办的那张虚拟卡（尾号0178，月限额100元）丢失了，请帮我正式挂失这张卡` | none |
| 补办 (replace) | `请为我刚才挂失的虚拟卡（原卡尾号0178）补办一张新卡` | none |

One natural turn per leg; the `0178` tail is the mask tail the harness itself just created (`****0178`).

## Model tool calls observed (RAW DB rows)

| # | tool | ToolInvocation.argsJson | status | invocation id (run / ordinal) | PendingAction.argsJson | riskLevel | requiresMfa | PendingAction.status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `completed` | `call_70744a67-ccec-4df3-8a69-9b8bcaf2f346` (run `cmvbyxale0000ewf8ub5hyyzu`, ordinal 3) | `{"monthlyLimit":"100.00"}` | `RED` | `true` | `executed` |
| 2 | `report_lost_card` | `{"cardId":"cardidem_c538003777f2d1483583d68daafac3a2","reason":"用户反馈卡片丢失，申请正式挂失"}` | `completed` | `call_769c5463-7164-4268-a66c-9d0f0f677481` (run `cmvbyxg4t005iewf8nmkbp4jb`, ordinal 3) | identical | `RED` | `true` | `executed` |
| 3 | `replace_card` | `{"cardId":"cardidem_c538003777f2d1483583d68daafac3a2"}` | `completed` | `call_318f855b-be79-4f45-a954-0d5925104c55` (run `cmvbyxk6500cyewf8czt1dvig`, ordinal 2) | identical | `RED` | `true` | `executed` |

- `errorCode=null`, `attempt=1` on all three: no retry, no failure.
- PendingAction ids: `cmvbyxcp1004newf8n9s6jtrc` (apply), `cmvbyxit200c5ewf8dtwwuspm` (report_lost_card), `cmvbyxmdy00i0ewf8pdc8i7co` (replace_card).
- **`consume_virtual_card` ToolInvocation count = 0** - both consumes used the REAL `/cards` dialog (`POST /api/cards/<id>/consume`), never a model tool.
- Tool results show the allowance hand-off: apply -> `payableAmount=100.00`; report_lost_card -> `70.00`; replace_card -> `70.00` (**not** 100.00).

## Confirmation / MFA panel

- A REAL panel appeared for every RED tool (gateway-persisted `PendingAction`, `driveRedTool` detected the MFA card); no fabricated-panel guard failure, `/api/actions` really had pending work.
- Completed by submitting the simulator code `123456` three times.
- `MfaChallenge`: **3** rows, all `status=verified`, `attempts=0`, `consumedAt` set - no wrong code, no lock, no re-prompt.

## Turn economy / nudges

- **No clarification, no nudge, no retry, no timeout**: every leg settled on its first natural turn (the tail prompts of `VC_APPLY_TURNS` / `vcReportLostTurns` / `vcReplaceTurns` were never sent).
- Network: exactly **1** 4xx - `POST /api/cards/cmvbyxmlm00ieewf8dcowfq12/consume -> 422 LIMIT_EXCEEDED` - the deliberate exhausted-allowance refusal. console error = 1 (same request), pageerror = 0.

## DB cross-check (prisma/live-acceptance.db, RAW rows)

| id | type | status | numberMasked | monthlyLimitMinor | creditLimitMinor | availableLimitMinor | linkedAccountId | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| card_credit | CREDIT | ACTIVE | `****6688` | 1800000 | 1800000 | 1800000 | null | null |
| card_debit | DEBIT | ACTIVE | `****8821` | null | null | null | null | null |
| card_virtual | VIRTUAL | ACTIVE | `****7788` | 500000 | null | null | acct_checking | null |
| cardidem_c538003777f2d1483583d68daafac3a2 (SOURCE) | VIRTUAL | **LOST** | `****0178` | 10000 | null | null | acct_checking | cmvbyxmlm00ieewf8dcowfq12 |
| cmvbyxmlm00ieewf8dcowfq12 (REPLACEMENT) | VIRTUAL | **ACTIVE** | `****9937` | 10000 | null | null | acct_checking | null |

- Source stays terminal **LOST** and links `replacedByCardId` to the replacement; exactly **ONE** new ACTIVE VIRTUAL card was created; the seed's 3 cards are untouched (5 rows).
- `linkedAccountId` is the SAME (`acct_checking`) on source and replacement; mask changed `****0178` -> `****9937`; `monthlyLimitMinor` continuous at `10000`.
- No credit fields on either virtual card (debit instrument).

Allowance progression: **100.00** (apply) -> **70.00** (after the 30.00 pre-lost consume; report_lost_card result) -> **70.00** after replace_card (rendered `当前可支付金额 = ¥70.00`, never reset to 100.00) -> **0.00** after the 70.00 consume on the NEW card -> still **0.00** after the refused 1.00 attempt.

Exactly ONE real frontend consume on the NEW card, exactly once:

- `Transaction` **cmvbyxntg00iuewf8fgn46cak**: `amountMinor=-7000`, `direction=DEBIT`, `channel=CARD`, `category=购物`, `merchant=虚拟卡补办续限验证`.
- `CardConsumption` **cmvbyxntg00ivewf8wmcugoit**: `cardId=cmvbyxmlm00ieewf8dcowfq12`, `accountId=acct_checking`, `amountMinor=7000`, `executionKey=a49b47d1-9db9-48be-a7bb-cd2351cf410d`.
- Balance debited exactly once: `acct_checking.balanceMinor` **2355000 -> 2348000** (final RAW `2348000`).
- Pre-lost consume on the SOURCE card: `Transaction` **cmvbyxfty005gewf8nks7b1oh** (`-3000`) + `CardConsumption` **cmvbyxfty005hewf8544l7b03** (`3000`, `executionKey=0f87cf1c-fb2a-43bf-8a0c-54f9d02bb04e`); balance `2358000 -> 2355000`. The 挂失 leg moved no funds.
- Refused 1.00 attempt: zero `Transaction`, zero `CardConsumption`, unchanged balance, dialog text `超出本月消费限额`.

Credit-available NOT doubled: the only non-LOST `CREDIT` row is `card_credit` (1800000 minor = **18,000.00**).

## Final on-page state

- `/cards` showed the replacement tile with `账户可用余额 = ¥23,550.00`, `当前可支付金额 = ¥70.00`, no credit rows.
- After the 70.00 consume the replacement reads `¥0.00`; the last dialog attempt rendered `超出本月消费限额` with nothing moved.

## Screenshots (preserved per round)

- `output/playwright/live/lE-round2/01-lE-replacement-card.png`
- `output/playwright/live/lE-round2/02-lE-exhausted-refusal.png`

(The harness always writes these two fixed names into `output/playwright/live/`, so they were copied into the round folder before the next run overwrote them.)

## Not verified in this round

- `creditAvailable` derived from RAW `Card` rows (non-LOST CREDIT sum), not from a post-run dashboard `GET`.
- No typed `AgentSession.stateJson` assistant block list exists for this provider run, so per-turn model prose is not part of this evidence; tool arguments come from `ToolInvocation.argsJson`.
- Whether an extra plain `确认` click preceded the MFA card is not recorded; the provable gate is `PendingAction` + `MfaChallenge`.
