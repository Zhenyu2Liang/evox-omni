# lG ROUND 8 — PASS (second independent live round on product head `d1cccd00`)

- Scenario: `lG-live-full-card-loss-replace-chain-single-session` (`scenarioFullCardChain`, `tests/e2e/card-replace-chain.e2e-helper.ts`), selected via `LIVE_SCENARIOS='lG'`
- Mode: REAL model, REAL browser (Chrome), freshly reprovisioned isolated DB `prisma/live-acceptance.db` (its **own** process, DB and dev server — run strictly after round 7 had exited and released its port)
- **Certified product head: `d1cccd00`** (`logs/lG-r8-producthead.txt`; `git rev-parse --short HEAD` taken BEFORE the run, working tree clean → the product tree that ran is exactly HEAD's)
- Equivalence proof after the run (`logs/_equivalence.txt`, 2026-10-18T17:58:23Z): `git diff --stat 6a20dd93 HEAD -- banking-sdk agent security planner lib app components prisma scripts` → **EMPTY**; `git diff --stat d1cccd00 HEAD -- <same paths>` → **EMPTY**; `git status --porcelain -- banking-sdk agent security planner lib app components prisma scripts tests` → **EMPTY**. The delta `6a20dd93 → HEAD` is evidence artifacts plus `tests/e2e/CONTEXT.md`, `tests/e2e/panel-claim.e2e-helper.ts`, `tests/unit/panel-claim.test.ts` — **no product code**.
- Exact command (from the repo root; round 8 of two independent rounds):
  `$env:LLM_MODE='live'; $env:LIVE_SCENARIOS='lG'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lG-r8.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lG-r8.out & exit !EC!"; exit $LASTEXITCODE`
- Exit-code signals — both agree: tool-reported **0** (`logs/lG-r8-exitcode.txt` = `TOOL-EXITCODE=0`); log line `EXIT=0   ` (`logs/lG-r8.out:19`)
- Duration: **53.5 s**: start `2026-10-18T17:56:32.479Z` → end `2026-10-18T17:57:25.989Z` (`logs/lG-r8-start.txt`, `logs/lG-r8-end.txt`)
- Summary line verbatim: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` (`logs/lG-r8.out:18`)
- Health: `/api/health={"ok":true,"data":{"status":"ok","time":1792346217400,"llmMode":"live"}}` (`logs/lG-r8.out:8`); server `next dev (pid=60768) → http://localhost:55177`; browser `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Model: `deepseek-flash` (harness header + `evidence.model`); 7 `ModelRequest` rows and 7 `provider_request_payload` events all carrying `model=deepseek-flash` (`logs/_r8tables.txt`)
- Persistence census (`logs/lG-r8-db.txt`, 29 tables): `AgentRun` 12, `AgentSession` 1, `ModelRequest` 7, `ToolInvocation` 13 (all `status=completed`, `attempt=1`, `errorCode=null`), `PendingAction` 6, `MfaChallenge` 6 (all `verified`, `attempts=0`, `maxAttempts=3`), `ExecutionReceipt` 6, `AuditLog` 6, `AuthorizationDecision` 7, `Card` 6, `CardConsumption` 2, `Account` 2, `Transaction` 234, `AgentRunEvent` 1113; `CircuitBreakerState` `user:user_liming` `failures=0 locked=false`; `ManualReview` 0 rows, `SecurityEvent` 0 rows, `RiskSignal` 0 rows
- Noise: `累计网络 4xx/5xx：1，console error：1，pageerror：0` — the single 422 is the **expected** limit refusal `POST /api/cards/cmve4o40u00h750f82brw1xuc/consume — {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}` (`logs/lG-r8.out:10-11,14`)

## Turn-by-turn replay (ONE chat session; prompts verbatim, never edited)

Baseline at scenario start: 3 cards (`card_credit`, `card_debit`, `card_virtual`); `acct_checking` = 23580.00. Every leg is bounded (`MAX_TURNS_PER_LEG = 6`); every leg succeeded on its first prompt (the evidence chain stores a single prompt per leg), so no clarification or retry was consumed.

| # | Verbatim user prompt | Verbatim model prose | Tool + args | `PendingAction` | `MfaChallenge` |
|---|---|---|---|---|---|
| 1 | 请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。 | 我会先确认卡片信息，同时声明本次需求。\n虚拟卡申请处理结果：第1笔操作实际执行成功；虚拟卡 \*\*\*\*3433 已开通（月限额 ¥100.00）。 | `describe_turn{operations:[get_cards,apply_virtual_card]}` + `get_cards{}` + `apply_virtual_card` `{"monthlyLimit":"100.00"}` | `cmve4nv4o004r50f876wfwwbz` RED requiresMfa=true **executed** | `cmve4nv4r004s50f8azdu7z0j` verified attempts=0/3 |
| — | FRONT-END: real `/cards` consume dialog 30.00 (购物 / 虚拟卡开卡消费验证) → payable 70.00 | — | — | — | — |
| 3 | 尾号3433的虚拟卡信息泄露，请正式挂失，我确认不可撤销。 | 我先声明本次操作并提交挂失请求。 | `describe_turn{operations:[report_lost_card]}` + `report_lost_card` `{"cardId":"cardidem_615245bdad1c98d06c040c42547ece1e","reason":"卡片信息泄露，用户主动申请正式挂失"}` | `cmve4o0cz00b450f811n213n1` RED requiresMfa=true **executed** | `cmve4o0d000b550f8syx60wdr` verified attempts=0/3 |
| 4 | 请为刚才正式挂失的尾号3433虚拟卡再补办一张新卡。 | 我先说明本次操作，然后为已挂失的虚拟卡补办新卡。 | `describe_turn{operations:[replace_card]}` + `replace_card` `{"cardId":"cardidem_615245bdad1c98d06c040c42547ece1e"}` | `cmve4o39v00gt50f8ttbdmgia` RED requiresMfa=true — `awaiting_mfa` at park time, **executed** after MFA | `cmve4o39w00gu50f8rrrttkyu` verified attempts=0/3 |
| — | FRONT-END: consume 70.00 (虚拟卡补办续限验证) → payable 0.00; then 1.00 **REFUSED** `422 LIMIT_EXCEEDED` / 「超出本月消费限额」 | — | — | — | — |
| 6 | 尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。 | 我先声明本次操作，然后提交挂失请求。 | `describe_turn{operations:[report_lost_card]}` + `report_lost_card` `{"cardId":"card_credit","reason":"信用卡丢失，用户确认正式挂失且不可撤销"}` | `cmve4o7kw00mb50f8l2et8ckd` RED requiresMfa=true **executed** | `cmve4o7kx00mc50f8ylhoxirb` verified attempts=0/3 |
| 7 | 请为刚挂失的尾号6688信用卡补办新卡。 | 我先声明本次操作，然后为已挂失的信用卡补办新卡。 | `describe_turn{operations:[replace_card]}` + `replace_card` `{"cardId":"card_credit"}` | `cmve4oa4x00qy50f8625f0608` RED requiresMfa=true — `awaiting_mfa` at park time (no new card, source still LOST), **executed** after MFA | `cmve4oa4y00qz50f8vv1bjlxx` verified attempts=0/3 |
| 8 | 确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。 | 我来实际发起补办信用卡的请求，让它在面板中形成待验证状态。 | `describe_turn{operations:[replace_card]}` + `replace_card` `{"cardId":"card_credit"}` — a **real controlled tool call** | `cmve4ocnj00vo50f8f4gp8rnv` RED requiresMfa=true, `awaiting_mfa` when parked, **executed** after a real panel MFA submission | `cmve4ocnk00vp50f8vt8dndz5` verified attempts=0/3 |

Security parking proof (`evidence.toolEvents`): every RED call ended with `__SECURITY_BLOCK__{"actionId":"…","decisionKind":"require_mfa"}` and only executed after the real `123456` panel submission. No turn faked a panel: the step-8 panel was rendered from the persisted `PendingAction` row and the guard `assertNoFabricatedConfirmationPanel` raised nothing on any prose turn.

### Step 8 differs from round 7 — both accepted, neither creates a second card
In round 7 the same verbatim nudge produced **prose only** (no `PendingAction`; the model explained the replacement was already done). In round 8 the model actually emitted `replace_card` again; the gateway parked it (`awaiting_mfa`), the real panel rendered, MFA `123456` was submitted, and the command **replayed the existing replacement card** — `PendingAction.resultJson` returns `{"id":"cmve4oa9d00rc50f8njjc711f", … "numberMasked":"****0495"}` and its `commandDigest` (`14fc01beedc9156bb968b4e743dc79231f75ee172248e4fa3b7429bd8338cb6d`) is byte-identical to the step-7 command's digest, i.e. the same command re-verified and replayed, not a second issuance. Card count stayed 6 → 6 and the unique ACTIVE CREDIT id stayed `cmve4oa9d00rc50f8njjc711f`. `finalTurn` evidence: `mfaCompleted=true`, `panelRendered=true`, `cardCountBefore=6`, `cardCountAfter=6`.

## Card rows (SQLite `Card`, `logs/lG-r8-db.txt`) — 6 = scenario baseline 3 + VIRTUAL source + VIRTUAL replacement + CREDIT replacement

| id | type | status | numberMasked | linkedAccountId | replacedByCardId | credit_limit_minor / available_limit_minor | monthly_limit_minor |
|---|---|---|---|---|---|---|---|
| `card_credit` | CREDIT | **LOST** | \*\*\*\*6688 | null | `cmve4oa9d00rc50f8njjc711f` | 1800000 / 1800000 | 1800000 |
| `cmve4oa9d00rc50f8njjc711f` | CREDIT | **ACTIVE** | \*\*\*\*0495 | null | null | **1800000 / 1800000** | 1800000 |
| `card_debit` | DEBIT | ACTIVE | \*\*\*\*8821 | null | null | null / null | null |
| `card_virtual` | VIRTUAL | ACTIVE | \*\*\*\*7788 | acct_checking | null | null / null | 500000 |
| `cardidem_615245bdad1c98d06c040c42547ece1e` | VIRTUAL | **LOST** | \*\*\*\*3433 | acct_checking | `cmve4o40u00h750f82brw1xuc` | null / null | 10000 |
| `cmve4o40u00h750f82brw1xuc` | VIRTUAL | **ACTIVE** | \*\*\*\*0280 | acct_checking | null | null / null | 10000 |

Card count is derived from the scenario baseline (3), never hardcoded: 4 at the VIRTUAL replacement, 5 after the credit loss, 6 after the credit replacement, 6 → 6 on the final turn. Replacement numbers are fresh (VIRTUAL \*\*\*\*3433 → \*\*\*\*0280; CREDIT \*\*\*\*6688 → \*\*\*\*0495 ≠ source).

## Money / ledger
- `acct_checking.balance_minor` = **2348000** (23480.00) at the end; `acct_savings` `balance_minor` = 5000000 unchanged. Progress: 23580.00 → 23550.00 (30.00) → **23480.00** (70.00). The 挂失 and 补办 legs themselves left money untouched.
- `Transaction`: exactly 2 new rows, both `channel=CARD` `direction=DEBIT`, `occurredAt=2026-09-25T04:00:00Z` (server-owned `demoNow()`, UTC+08:00 month window), `createdAt` 17:57:05.304Z / 17:57:13.887Z vs the seed rows' 17:56:54.612Z: `cmve4nyjc005k50f8zdnyok6p` −3000 (虚拟卡开卡消费验证), `cmve4o55r00hn50f8ghrtcb6s` −7000 (虚拟卡补办续限验证). `GET /api/bills` 新增 2 条、消失 0 条; dashboard final 23480.00.
- `CardConsumption`: exactly 2 — `cmve4nyjd005l50f8kd3tzco8` 3000 on the source VIRTUAL card (`cardidem_6152…`), `cmve4o55r00ho50f8l3g2t6xh` 7000 on the replacement (`cmve4o40u…`); the historical row keeps its original card attribution.
- Virtual payable: 100.00 → 70.00 (after 30.00) → **70.00 after replacement (continuity, never reset to 100.00)** → 0.00 (after 70.00); the following `1.00` was refused with 超出本月消费限额 / `422 LIMIT_EXCEEDED` and **zero** financial change (no `Transaction`, no `CardConsumption`, balance untouched). Tile rendering at replacement: `{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}`.
- Credit: replacement tile `{"信用额度":"¥18,000.00","可用额度":"¥18,000.00"}`; non-LOST credit total **18000.00** (`availableMinor=1800000`); naive all-CREDIT total 3600000 minor (36000.00) explicitly excluded as the bug signature.

## Per-assertion verdicts (round 8)
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
| Prompt 8 → no second replacement card (count 6 → 6, unique ACTIVE CREDIT id unchanged) — in this round the model re-issued `replace_card`, which replayed the existing replacement | PASS |
| Cash/ledger invariance: only the two successful consumptions change money | PASS |
| `assertNoFabricatedConfirmationPanel` on every prose turn; ≤6 natural turns per leg | PASS (every panel claim this round was backed by a real `PendingAction` row) |

## Verdict: **ROUND 8 = PASS** (exit 0 from both signals; `PASS 1 ｜ FAIL 0 ｜ SKIP 0`)

## Evidence (all under gitignored `logs/` unless stated)
- `logs/lG-r8.out` (full stdout, 20 lines), `logs/lG-r8-exitcode.txt` (`TOOL-EXITCODE=0`), `logs/lG-r8-start.txt`, `logs/lG-r8-end.txt`, `logs/lG-r8-producthead.txt` (`d1cccd00`)
- `logs/lG-r8-db.txt` (SQLite dump, 3,107,193 bytes / 29 tables), `logs/lG-r8.db` (WAL-checkpointed copy, 3,682,304 bytes, no `-wal`/`-shm`/`-journal` left), `logs/lG-r8-evidence.json` (harness-written `writeScenarioEvidence('lG', …)`, 28,311 bytes), `logs/lG-r8-dbfacts.txt`, `logs/lG-r8-targeted.txt`, `logs/lG-r8-evsum.txt`, `logs/lG-r8-prerun.txt`, `logs/lG-r8-postrun.txt`, `logs/lG-r8-postcleanup.txt`
- Screenshots (committed): `output/playwright/live/lG-headd1cccd00-round8/01-lG-virtual-replacement.png` (88,677 B), `02-lG-virtual-refusal.png` (105,619 B), `03-lG-credit-replacement.png` (97,661 B) — copied immediately after the round, before any further run could overwrite the fixed harness filenames

## Cleanup proof
`logs/lG-r8-postcleanup.txt` (2026-10-18T17:58:06Z): `next dev` pid **60768 gone**; port **55177 not LISTEN** (`port55177_LISTEN=False`; a lingering non-listening TCP entry from normal teardown remains, `port55177_ANY=True`); `Get-NetTCPConnection -State Listen` back to the pre-run baseline **64 entries / 51 distinct ports**; `node` ids `30644,57132,64116` identical to the pre-run snapshot (`new_node_ids=` empty) — no harness node survived. `chrome` count 42 in both snapshots; one pid appeared **after** my round had exited (pid 44912, started 17:57:57Z, i.e. 31 s after my `EXIT=0`) and is therefore not my harness's browser; it was **not** killed (it belongs to a concurrently running agent), and neither were any pre-existing Chrome instances.
