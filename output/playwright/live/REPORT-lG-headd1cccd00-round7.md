# lG ROUND 7 — PASS (independent live round on product head `d1cccd00`)

- Scenario: `lG-live-full-card-loss-replace-chain-single-session` (`scenarioFullCardChain`, `tests/e2e/card-replace-chain.e2e-helper.ts`), selected via `LIVE_SCENARIOS='lG'`
- Mode: REAL model, REAL browser (Chrome), freshly reprovisioned isolated DB `prisma/live-acceptance.db` (own process, own DB, own dev server)
- **Certified product head: `d1cccd00`** (`logs/lG-r7-producthead.txt`; taken with `git rev-parse --short HEAD` BEFORE the run, working tree clean → the product tree that ran is exactly HEAD's)
- Equivalence proof after the run (`logs/_equivalence.txt`, taken 2026-10-18T17:58:23Z): `git diff --stat 6a20dd93 HEAD -- banking-sdk agent security planner lib app components prisma scripts` → **EMPTY**; `git diff --stat d1cccd00 HEAD -- <same paths>` → **EMPTY**; `git status --porcelain -- banking-sdk agent security planner lib app components prisma scripts tests` → **EMPTY**. The only delta between `6a20dd93` and HEAD is evidence artifacts plus `tests/e2e/CONTEXT.md`, `tests/e2e/panel-claim.e2e-helper.ts`, `tests/unit/panel-claim.test.ts` — **no product code**.
- Exact command (from the repo root; round 7 of two independent rounds):
  `$env:LLM_MODE='live'; $env:LIVE_SCENARIOS='lG'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lG-r7.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lG-r7.out & exit !EC!"; exit $LASTEXITCODE`
- Exit-code signals — both agree: tool-reported **0** (`logs/lG-r7-exitcode.txt` = `TOOL-EXITCODE=0`); log line `EXIT=0   ` (`logs/lG-r7.out:19`)
- Duration: **2 m 57 s** (176.9 s): start `2026-10-18T17:51:38.515Z` → end `2026-10-18T17:54:35.399Z` (`logs/lG-r7-start.txt`, `logs/lG-r7-end.txt`)
- Summary line verbatim: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` (`logs/lG-r7.out:18`)
- Health: `/api/health={"ok":true,"data":{"status":"ok","time":1792345921539,"llmMode":"live"}}` (`logs/lG-r7.out:8`); server `next dev (pid=18956) → http://localhost:60637`; browser `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Model: `deepseek-flash` (harness header + `evidence.model`); 13 `ModelRequest` rows, 13 `provider_request_payload` events all carrying `model=deepseek-flash` (`logs/lG-r7-newtx.txt:11-13`)
- Persistence census (`logs/lG-r7-dbfacts.txt`, `logs/lG-r7-db.txt`): 6 `Card`, 2 `Account`, 5 `PendingAction`, 5 `MfaChallenge` (all `verified`, `attempts=0`, `maxAttempts=3`), 5 `ExecutionReceipt`, 5 `AuditLog`, 7 `AuthorizationDecision`, 12 `ToolInvocation` (all `status=completed`, `attempt=1`, `errorCode=null`), 2 `CardConsumption`, 234 `Transaction`; `CircuitBreakerState` `user:user_liming` `failures=0 locked=false`; `ManualReview` 0 rows, `SecurityEvent` 0 rows, `RiskSignal` 0 rows
- Noise: `累计网络 4xx/5xx：1，console error：1，pageerror：0` — the single 422 is the **expected** limit refusal `POST /api/cards/cmve4hx5v00f9b4f8vy4ups07/consume — {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}` (`logs/lG-r7.out:10-11,14`)

## Turn-by-turn replay (ONE chat session; prompts verbatim, never edited)

Baseline at scenario start: 3 cards (`card_credit`, `card_debit`, `card_virtual`); `acct_checking` = 23580.00. Every leg is bounded (`MAX_TURNS_PER_LEG = 6`); no leg needed a clarification or a retry beyond its single prompt (the `→` join in the evidence chain shows one prompt per leg).

| # | Verbatim user prompt | Verbatim model prose | Tool + args | `PendingAction` | `MfaChallenge` |
|---|---|---|---|---|---|
| 1 | 请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。 | 虚拟卡申请处理结果：第1笔操作实际执行成功；虚拟卡 \*\*\*\*1865 已开通（月限额 ¥100.00）。 | `apply_virtual_card` `{"monthlyLimit":"100.00"}` | `cmve4hjdp0038b4f8fm39b6mt` RED requiresMfa=true **executed** | `cmve4hjdr0039b4f8cx6c2dee` verified attempts=0/3 |
| — | FRONT-END: real `/cards` consume dialog 30.00 (购物 / 虚拟卡开卡消费验证) → payable 70.00 | — | — | — | — |
| 3 | 尾号1865的虚拟卡信息泄露，请正式挂失，我确认不可撤销。 | (无散文) | `report_lost_card` `{"cardId":"cardidem_18833669ba4a273768d277b51356b65c","reason":"卡片信息泄露，用户确认正式挂失且不可撤销"}` | `cmve4hph100a2b4f8if98f4b8` RED requiresMfa=true **executed** | `cmve4hph300a3b4f8ab8jy6rl` verified attempts=0/3 |
| 4 | 请为刚才正式挂失的尾号1865虚拟卡再补办一张新卡。 | (无散文) | `replace_card` `{"cardId":"cardidem_18833669ba4a273768d277b51356b65c"}` | `cmve4hwb400evb4f8fpe0thpw` RED requiresMfa=true — `awaiting_mfa` at park time, **executed** after MFA | `cmve4hwb500ewb4f8sn4k7xb2` verified attempts=0/3 |
| — | FRONT-END: consume 70.00 (虚拟卡补办续限验证) → payable 0.00; then 1.00 **REFUSED** `422 LIMIT_EXCEEDED` / 「超出本月消费限额」 | — | — | — | — |
| 6 | 尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。 | (无散文) | `report_lost_card` `{"cardId":"card_credit","reason":"信用卡丢失，用户确认正式挂失且不可撤销"}` | `cmve4i19000jxb4f8nh8sxick` RED requiresMfa=true **executed** | `cmve4i19100jyb4f89ku18agl` verified attempts=0/3 |
| 7 | 请为刚挂失的尾号6688信用卡补办新卡。 | (无散文) | `replace_card` `{"cardId":"card_credit"}` | `cmve4i46c00nsb4f8tc17e17n` RED requiresMfa=true — `awaiting_mfa` at park time (no new card, source still LOST), **executed** after MFA | `cmve4i46d00ntb4f8evnbr8xm` verified attempts=0/3 |
| 8 | 确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。 | 我刚查了最新卡状态，这笔业务其实已经办理完成，不需要再发起新的待确认操作：\n\n信用卡 \*\*\*\*6688：状态“已挂失”，已关联补办出的新卡 \*\*\*\*8718\n新卡信用卡 \*\*\*\*8718：状态“正常”，信用额度 ¥18,000.00，可用额度 ¥18,000.00\n\n补办只处理一次，因此我没有再创建新的补办请求。原挂失卡片保持挂失状态，不会被恢复；你可以直接使用新卡 \*\*\*\*8718。如果还需要其他卡（比如 \*\*\*\*0433 或 \*\*\*\*7788）的锁定、挂失或补办，告诉我具体卡号即可。 | `describe_turn` + `get_cards` only — **no `replace_card`, no new `PendingAction`** | none created (`finalTurn.action === undefined`, `mfaCompleted=false`, `panelRendered=false`) | — |

Security parking proof (`evidence.toolEvents`): every RED call ended with `__SECURITY_BLOCK__{"actionId":"…","decisionKind":"require_mfa"}` (sequences 210, 147, 141, 113, 107) and only executed after the real `123456` panel submission. The prose of step 8 explicitly states that **no** panel is pending, so `assertNoFabricatedConfirmationPanel` correctly raised nothing.

## Card rows (SQLite `Card`, `logs/lG-r7-db.txt`) — 6 = scenario baseline 3 + VIRTUAL source + VIRTUAL replacement + CREDIT replacement

| id | type | status | numberMasked | linkedAccountId | replacedByCardId | credit_limit_minor / available_limit_minor | monthly_limit_minor |
|---|---|---|---|---|---|---|---|
| `card_credit` | CREDIT | **LOST** | \*\*\*\*6688 | null | `cmve4i4c300o6b4f8cqjdvnrp` | 1800000 / 1800000 | 1800000 |
| `cmve4i4c300o6b4f8cqjdvnrp` | CREDIT | **ACTIVE** | \*\*\*\*8718 | null | null | **1800000 / 1800000** | 1800000 |
| `card_debit` | DEBIT | ACTIVE | \*\*\*\*8821 | null | null | null / null | null |
| `card_virtual` | VIRTUAL | ACTIVE | \*\*\*\*7788 | acct_checking | null | null / null | 500000 |
| `cardidem_18833669ba4a273768d277b51356b65c` | VIRTUAL | **LOST** | \*\*\*\*1865 | acct_checking | `cmve4hx5v00f9b4f8vy4ups07` | null / null | 10000 |
| `cmve4hx5v00f9b4f8vy4ups07` | VIRTUAL | **ACTIVE** | \*\*\*\*0433 | acct_checking | null | null / null | 10000 |

Card count is derived from the scenario baseline (3), never hardcoded: 4 at the VIRTUAL replacement, 5 after the credit loss, 6 after the credit replacement, and 6 → 6 on the final nudge. The unique ACTIVE CREDIT id stays `cmve4i4c300o6b4f8cqjdvnrp`.

## Money / ledger
- `acct_checking.balance_minor` = **2348000** (23480.00) at the end; `acct_savings` 5000000 unchanged. Progress: 23580.00 → 23550.00 (30.00) → **23480.00** (70.00). Every 挂失/补办 left money unchanged.
- `Transaction`: exactly 2 new rows, both `channel=CARD` `direction=DEBIT`, `occurredAt=2026-09-25T04:00:00Z` (server-owned `demoNow()`, UTC+08:00 month window): `cmve4hmqh0041b4f8ru542es8` −3000 (虚拟卡开卡消费验证), `cmve4hybc00fpb4f8pb3pjxia` −7000 (虚拟卡补办续限验证). `GET /api/bills` 新增 2 条、消失 0 条; dashboard final 23480.00.
- `CardConsumption`: exactly 2 — `cmve4hmqi0042b4f84ztmivuj` 3000 on the source VIRTUAL card, `cmve4hybd00fqb4f8wctptfpm` 7000 on the replacement (historical consumption keeps its original card attribution).
- Virtual payable: 100.00 → 70.00 (after 30.00) → **70.00 after replacement (continuity, never reset to 100.00)** → 0.00 (after 70.00); the following `1.00` was refused with 超出本月消费限额 / `422 LIMIT_EXCEEDED` and **zero** financial change. Tile rendering at replacement: `{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}`.
- Credit: replacement tile `{"信用额度":"¥18,000.00","可用额度":"¥18,000.00"}`; non-LOST credit total **18000.00**; naive all-CREDIT total 3600000 minor (36000.00) explicitly excluded.

## Per-assertion verdicts (round 7)
| Assertion | Verdict |
|---|---|
| Prompt 1 → new VIRTUAL/ACTIVE, `monthlyLimitMinor=10000`, `linkedAccountId='acct_checking'`, real confirmation + MFA `123456` | PASS |
| Front-end consume 30.00 through the real `/cards` dialog → payable 70.00 | PASS |
| Prompt 3 (masked tail from step 1) → `report_lost_card`, source LOST, money unchanged | PASS |
| Prompt 4 → real `replace_card` PendingAction (RED, requiresMfa); before verification card count still 4, no new card, source still LOST | PASS |
| After MFA exactly ONE new VIRTUAL/ACTIVE on the same account, allowance continuous 70.00 before **and** after | PASS |
| Front-end consume 70.00 succeeds (payable 0.00); 1.00 rejected `422 LIMIT_EXCEEDED` / 「超出本月消费限额」 with zero financial change | PASS |
| Prompt 6 → `card_credit` LOST | PASS |
| Prompt 7 (the prompt previously refused as manual-only) → the model really emitted `replace_card` (RED, requiresMfa, parked before issuance); after MFA exactly ONE new CREDIT/ACTIVE, fresh number ≠ \*\*\*\*6688, `replacedByCardId` link, limits 1800000/1800000, non-LOST credit total 18000.00 | PASS (no manual-only refusal, no prose-only turn) |
| Prompt 8 → no second replacement card (count 6 → 6, unique ACTIVE CREDIT id unchanged) | PASS |
| Cash/ledger invariance: only the two successful consumptions change money | PASS |
| `assertNoFabricatedConfirmationPanel` on every prose turn; ≤6 natural turns per leg | PASS (guard raised nothing; step-8 prose states no panel is pending) |

## Verdict: **ROUND 7 = PASS** (exit 0 from both signals; `PASS 1 ｜ FAIL 0 ｜ SKIP 0`)

## Honest note — an earlier attempt-0 execution of this round selected ZERO scenarios
The first launch of round 7 passed the **long scenario name** (`LIVE_SCENARIOS='lG-live-full-card-loss-replace-chain-single-session'`). `selectedIds()` matches on the scenario **id** (`lG`), so nothing was selected: that process finished in ~32 s printing `== 汇总：PASS 0 ｜ FAIL 0 ｜ SKIP 0 ==` and `EXIT=0`. Its stdout is preserved as `logs/lG-r7-attempt0-emptyselection.out`. This is a **harness-invocation error of mine, not a product result**, and it is reported so that the two `EXIT=0` lines in this round are not confused: only the execution documented above (with `LIVE_SCENARIOS='lG'`) ran the scenario.

## Evidence (all under gitignored `logs/` unless stated)
- `logs/lG-r7.out` (full stdout, 20 lines), `logs/lG-r7-exitcode.txt` (`TOOL-EXITCODE=0`), `logs/lG-r7-start.txt`, `logs/lG-r7-end.txt`, `logs/lG-r7-producthead.txt` (`d1cccd00`)
- `logs/lG-r7-db.txt` (SQLite dump, 3,669,513 bytes / 29 tables), `logs/lG-r7.db` (WAL-checkpointed copy, `-wal`/`-shm`/`-journal` removed), `logs/lG-r7-evidence.json` (harness-written `writeScenarioEvidence('lG', …)`), `logs/lG-r7-dbfacts.txt`, `logs/lG-r7-newtx.txt`, `logs/lG-r7-prerun.txt`, `logs/lG-r7-postcleanup.txt`
- Screenshots (committed): `output/playwright/live/lG-headd1cccd00-round7/01-lG-virtual-replacement.png` (88,450 B), `02-lG-virtual-refusal.png` (105,425 B), `03-lG-credit-replacement.png` (97,390 B) — copied out of the fixed harness filenames immediately after the round, before round 8 started

## Cleanup proof
`logs/lG-r7-postcleanup.txt` (2026-10-18T17:56:13Z): `next dev` pid **18956 gone**; port **60637 no longer LISTEN** (`port60637_present=False`; a lingering non-listening TCP entry from normal teardown remains, `port60637_any_state=True`); `Get-NetTCPConnection -State Listen` back to the pre-run baseline **64 entries / 51 distinct ports**; `node` count **3**, exactly the three pre-existing pids (`30644`, `57132`, `64116`) from `logs/lG-r7-prerun.txt` — no harness node survived. `chrome` count 42 in both snapshots; the set differs by one pid that I did **not** start (pid 43884, present pre-run, exited) and one that appeared **after** my round had exited (pid 13840, started 17:55:21Z) — another agent's browser, deliberately not killed.
