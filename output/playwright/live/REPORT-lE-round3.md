# LIVE acceptance round report - scenario lE

- **Scenario id**: lE
- **Scenario name**: lE-live-virtual-card-replace-continuity
- **Round**: 3 of 3 (independent process, own DB reset, own dev server, own browser)
- **Harness**: tests/e2e/live-acceptance.e2e.ts
- **Exact command**: `$env:LIVE_SCENARIOS='lE'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
  (executed under `cmd /c "set LIVE_SCENARIOS=lE&& pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lE-round3.log 2>&1"` so stdout+stderr land in one UTF-8 log; env var and program identical)
- **Model**: REAL DeepSeek, `LLM_MODE=live`, model id **deepseek-flash** (entry printed `Live run uses the configured model.` - no forced override; scenario evidence JSON records `"model": "deepseek-flash"`)
- **Browser**: REAL headless Chrome - `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **Server**: REAL `next dev` pid 29408 on `http://localhost:58614`, `/api/health={"ok":true,...,"llmMode":"live"}`
- **Isolated DB**: `prisma/live-acceptance.db` (re-provisioned: delete -> `prisma db push` -> probe -> `tsx prisma/seed.ts`)
- **No mock, no interception**.

## Verbatim result

```text
PASS lE-live-virtual-card-replace-continuity - lE 实际发送（开卡）：「请帮我新开一张虚拟卡，月消费限额设为100元」 -> MFA 123456 -> 新虚拟卡 cardidem_a67567cd97bde03d018284ff6be58170（monthlyLimitMinor=10000、linkedAccountId=acct_checking）；挂失前消费 30.00（购物/虚拟卡挂失前消费验证）= 新增 CARD/DEBIT 流水 -3000（cmvbyyplv004tvcf8nm7blsp5）+ 1 条 CardConsumption（cmvbyyplw004uvcf8ok66vola），活期余额 23580.00 -> 23550.00；挂失实际发送：「我刚才新办的那张虚拟卡（尾号1421，月限额100元）丢失了，请帮我正式挂失这张卡」 -> MFA 123456 -> RAW status=LOST、资金零变化；补办实际发送：「请为我刚才挂失的虚拟卡（原卡尾号1421）补办一张新卡」 -> 「确认，请为我补办」 -> MFA 123456 -> cardidem_a67567cd97bde03d018284ff6be58170.replacedByCardId=cmvbyyykt00luvcf84cpwfs89（恰新增 1 张 VIRTUAL/ACTIVE 卡）；补办卡 RAW：linkedAccountId=acct_checking（= 原卡 acct_checking，继承修复生效）、monthlyLimitMinor=10000、卡号 ****7062 != 原卡 ****1421、无信用额度；家庭月限额连续：已用 3000 -> payableAmount=70.00（=70.00，不是 100.00），卡片渲染 {"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}；补办卡消费 70.00（购物/虚拟卡补办续限验证）= 新增 CARD/DEBIT 流水 -7000（cmvbyyzqf00mavcf8g6jkrxv3）+ 1 条 CardConsumption（cmvbyyzqf00mbvcf8vfl0i1g1），活期余额 23550.00 -> 23480.00（恰扣一次）-> payableAmount=0.00；额度用尽后 1.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 0.00；截图 ...\output\playwright\live\01-lE-replacement-card.png / ...\output\playwright\live\02-lE-exhausted-refusal.png；证据 JSON ...\logs\lE-evidence.json
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

> The PASS line above is reproduced from `logs/lE-round3.log` with ASCII `->` / `!=` substituted for the harness single-character arrow and not-equal glyphs, and the absolute worktree screenshot/evidence paths abbreviated to `...`. No other wording was altered; see `logs/lE-round3.log` for the byte-exact original.

- **Process exit code**: **0** (`logs/lE-round3.exit.txt` -> `EXIT=0`)
- **Summary line**: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`
- **Verdict**: **PASS** (both the printed PASS and the exit code were asserted)

## Natural-language prompts actually sent (verbatim)

| Leg | Turn 1 (sent) | Extra turns sent |
| --- | --- | --- |
| apply | `请帮我新开一张虚拟卡，月消费限额设为100元` | none |
| 挂失 (report lost) | `我刚才新办的那张虚拟卡（尾号1421，月限额100元）丢失了，请帮我正式挂失这张卡` | none |
| 补办 (replace) | `请为我刚才挂失的虚拟卡（原卡尾号1421）补办一张新卡` | **1** extra: `确认，请为我补办` |

The `1421` tail is the mask tail the harness itself just created (`****1421`). Unlike rounds 1-2, the 补办 leg did **not** settle on its first natural turn: the model produced no controlled tool call (prose-only acknowledgement), so the harness sent its second scripted natural turn `确认，请为我补办`, after which the real `replace_card` call appeared. `logs/lE-evidence-round3.json` records both turns under `replaceTurns`. No third turn, no timeout.

## Model tool calls observed (RAW DB rows)

| # | tool | ToolInvocation.argsJson | status | invocation id (run / ordinal) | PendingAction.argsJson | riskLevel | requiresMfa | PendingAction.status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `completed` | `call_ebc60ab9-fe90-4762-88f6-32fbf6836320` (run `cmvbyykmg0000vcf88q6ex0cs`, ordinal 2) | `{"monthlyLimit":"100.00"}` | `RED` | `true` | `executed` |
| 2 | `report_lost_card` | `{"cardId":"cardidem_a67567cd97bde03d018284ff6be58170","reason":"用户报告卡片丢失，申请正式挂失"}` | `completed` | `call_74b42b6a-93cb-4f5d-823f-2187e8acce3f` (run `cmvbyypvx004vvcf807z66880`, ordinal 4) | identical | `RED` | `true` | `executed` |
| 3 | `replace_card` | `{"cardId":"cardidem_a67567cd97bde03d018284ff6be58170"}` | `completed` | `call_f4e20b34-470d-4dbe-90e8-f7d4c1f13aac` (run `cmvbyyuoq00dtvcf8zk2jstqt`, ordinal 2) | identical | `RED` | `true` | `executed` |

- `errorCode=null`, `attempt=1` on all three: no retry, no failure.
- PendingAction ids: `cmvbyymk60040vcf8cav7pidf` (apply), `cmvbyyt4100d0vcf88jkbr4oc` (report_lost_card), `cmvbyyx0800j3vcf858cnp8ci` (replace_card); all `createdAt` 2026-10-17T05:41:52Z / 05:42:01Z / 05:42:06Z (simulated business clock).
- **`consume_virtual_card` ToolInvocation count = 0** - both consumes used the REAL `/cards` dialog (`POST /api/cards/<id>/consume`), never a model tool.
- Tool results show the allowance hand-off: apply -> `payableAmount=100.00`; report_lost_card -> `70.00`; replace_card -> `70.00` (**not** 100.00).

## Confirmation / MFA panel

- A REAL panel appeared for every RED tool (gateway-persisted `PendingAction`, `driveRedTool` detected the MFA card); no fabricated-panel guard failure, `/api/actions` really had pending work.
- Completed by submitting the simulator code `123456` three times.
- `MfaChallenge`: **3** rows - `cmvbyymka0041vcf8d9nsosan` (verified 05:41:54.798Z), `cmvbyyt4200d1vcf8s6etm429` (05:42:02.422Z), `cmvbyyx0a00j4vcf874ztfrvb` (05:42:08.516Z) - all `status=verified`, `attempts=0`, `consumedAt` set. No wrong code, no lock, no re-prompt.

## Turn economy / nudges

- **No timeout, no retry, no lock.** One extra scripted natural turn was needed on the 补办 leg (see the prompt table) because the model answered in prose without a controlled tool call; the harness' bounded tail turn resolved it and the real `replace_card` + MFA flow followed.
- Total natural turns this round: **4** (apply 1, 挂失 1, 补办 2).
- Network: exactly **1** 4xx - `POST /api/cards/cmvbyyykt00luvcf84cpwfs89/consume -> 422 LIMIT_EXCEEDED` (`超过虚拟卡月限额。`) - the deliberate exhausted-allowance refusal. console error = 1 (same request), pageerror = 0.

## DB cross-check (prisma/live-acceptance.db, RAW rows)

| id | type | status | numberMasked | monthlyLimitMinor | creditLimitMinor | availableLimitMinor | linkedAccountId | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| card_credit | CREDIT | ACTIVE | `****6688` | 1800000 | 1800000 | 1800000 | null | null |
| card_debit | DEBIT | ACTIVE | `****8821` | null | null | null | null | null |
| card_virtual | VIRTUAL | ACTIVE | `****7788` | 500000 | null | null | acct_checking | null |
| cardidem_a67567cd97bde03d018284ff6be58170 (SOURCE) | VIRTUAL | **LOST** | `****1421` | 10000 | null | null | acct_checking | cmvbyyykt00luvcf84cpwfs89 |
| cmvbyyykt00luvcf84cpwfs89 (REPLACEMENT) | VIRTUAL | **ACTIVE** | `****7062` | 10000 | null | null | acct_checking | null |

- Source stays terminal **LOST** and links `replacedByCardId` to the replacement; exactly **ONE** new ACTIVE VIRTUAL card was created; the seed's 3 cards are untouched (5 rows total).
- `linkedAccountId` is the SAME (`acct_checking`) on source and replacement; mask changed `****1421` -> `****7062`; `monthlyLimitMinor` continuous at `10000`.
- No credit fields on either virtual card (debit instrument).

Allowance progression: **100.00** (apply) -> **70.00** (after the 30.00 pre-lost consume; report_lost_card result) -> **70.00** after replace_card (rendered `当前可支付金额 = ¥70.00`, never reset to 100.00) -> **0.00** after the 70.00 consume on the NEW card -> still **0.00** after the refused 1.00 attempt.

Exactly ONE real frontend consume on the NEW card, exactly once:

- `Transaction` **cmvbyyzqf00mavcf8g6jkrxv3**: `amountMinor=-7000`, `direction=DEBIT`, `channel=CARD`, `category=购物`, `merchant=虚拟卡补办续限验证`.
- `CardConsumption` **cmvbyyzqf00mbvcf8vfl0i1g1**: `cardId=cmvbyyykt00luvcf84cpwfs89`, `accountId=acct_checking`, `amountMinor=7000`, `executionKey=1e89d874-ad39-47da-a04d-274c0f13c16c`.
- Balance debited exactly once: `acct_checking.balanceMinor` **2355000 -> 2348000** (final RAW `2348000`).
- Pre-lost consume on the SOURCE card: `Transaction` **cmvbyyplv004tvcf8nm7blsp5** (`-3000`) + `CardConsumption` **cmvbyyplw004uvcf8ok66vola** (`3000`, `executionKey=96696ff3-68f9-45cb-89d3-b3b7ac25984b`); balance `2358000 -> 2355000`. The 挂失 leg moved no funds.
- Refused 1.00 attempt: zero `Transaction`, zero `CardConsumption`, unchanged balance, dialog text `超出本月消费限额`.

Credit-available NOT doubled: the only non-LOST `CREDIT` row is `card_credit` (1800000 minor = **18,000.00**); the LOST source virtual card contributes nothing and no virtual card carries credit fields, so total available credit is unchanged from seed and not double-counted.

## Final on-page state

- `/cards` showed the replacement tile with `账户可用余额 = ¥23,550.00`, `当前可支付金额 = ¥70.00`, no credit rows.
- After the 70.00 consume the replacement reads `¥0.00`; the last dialog attempt rendered `超出本月消费限额` with nothing moved.

## Screenshots (preserved per round)

- `output/playwright/live/lE-round3/01-lE-replacement-card.png`
- `output/playwright/live/lE-round3/02-lE-exhausted-refusal.png`

(The harness always writes these two fixed names into `output/playwright/live/`, so they were copied into the round folder before any later run could overwrite them.)

## Not verified in this round

- `creditAvailable` derived from RAW `Card` rows (non-LOST CREDIT sum), not from a post-run dashboard `GET`.
- No typed `AgentSession.stateJson` assistant block list exists for this provider run (`assistantToolCalls: []`), so per-turn model prose is not part of this evidence; tool arguments come from `ToolInvocation.argsJson`.
- Whether an extra plain `确认` click preceded the MFA card is not recorded; the provable gate is `PendingAction` + `MfaChallenge`.
- The 补办 leg's first turn produced no controlled tool call; the harness' second turn resolved it. The exact prose the model emitted on that first turn is not captured (only the fact that no tool call resulted).
