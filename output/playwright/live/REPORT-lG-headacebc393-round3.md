# lG ROUND 3 — PASS (pilot live round, new scenario)

- Scenario: `lG-live-full-card-loss-replace-chain-single-session` (`scenarioFullCardChain`, `tests/e2e/card-replace-chain.e2e-helper.ts`)
- Mode: REAL model (`llmMode:"live"`), REAL browser (Chrome), isolated DB `prisma/live-acceptance.db`
- **Certified product head: `acebc393`**
- Equivalence proof: `git diff --stat acebc393 HEAD -- banking-sdk agent security planner lib app components prisma scripts` → EMPTY (recorded in `logs/product-diff-r3.txt`)
- Command: `$env:LIVE_SCENARIOS='lG'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lG-r3.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lG-r3.out & exit !EC!"; exit $LASTEXITCODE`
- Exit-code signals (both must agree): tool-reported **0**; log line `EXIT=0   ` (see `logs/lG-r3-exitcode.txt`, `logs/lG-r3.out:19`)
- Duration: **169 s** (2 m 49 s, measured by the tool; start/end stamps in `logs/lG-r3-start.txt`, `logs/lG-r3-end.txt`)
- Summary line: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` (`logs/lG-r3.out:18`)
- Health: `/api/health={"ok":true,"data":{"status":"ok","time":1792340387366,"llmMode":"live"}}`; server `next dev (pid=50376) → http://localhost:57014`; browser `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Model id from persisted events: `AgentRunEvent(eventType='provider_request_payload').payloadJson.payload.model` → `deepseek-flash` (all payload rows; `logs/lG-r3-db.txt`, section `AgentRunEvent provider_request_payload model counts`)
- Noise: `累计网络 4xx/5xx：1，console error：1，pageerror：0` — the single 422 is the EXPECTED limit refusal: `POST /api/cards/cmve1766400j3g0f8tef3dr9m/consume — {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}`

## Turn-by-turn replay (ONE chat session, verbatim prompts)

Baseline declared by the scenario: 3 cards (`card_credit`, `card_debit`, `card_virtual`).

| # | Verbatim user prompt | Model prose (verbatim) | Tool + persisted `PendingAction.argsJson` | `PendingAction` | `MfaChallenge` |
|---|---|---|---|---|---|
| 1 | 请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。 | (无散文) | `apply_virtual_card` `{"monthlyLimit":"100.00"}` | `cmve16wzd0062g0f8u7atdn6y` RED requiresMfa=true executed | verified attempts=0 maxAttempts=3 |
| — | FRONT-END: consume 30.00 via real `/cards` dialog (购物/虚拟卡开卡消费验证) | — | — | — | — |
| 3 | 尾号1865的虚拟卡信息泄露，请正式挂失，我确认不可撤销。 | 我先确认一下这张卡的当前状态，再为您提交挂失。 | `report_lost_card` `{"cardId":"cardidem_897d995e57a05d6ab6be1c63d0a693b1","reason":"卡片信息泄露，用户要求正式挂失"}` | `cmve172m500dmg0f8vuvi3meb` RED requiresMfa=true executed | verified attempts=0 maxAttempts=3 |
| 4 | 请为刚才正式挂失的尾号1865虚拟卡再补办一张新卡。 | (无散文) | `replace_card` `{"cardId":"cardidem_897d995e57a05d6ab6be1c63d0a693b1"}` | `cmve1761k00ipg0f87up0jf1h` RED requiresMfa=true executed | verified attempts=0 maxAttempts=3 |
| — | FRONT-END: consume 70.00 (虚拟卡补办续限验证) then attempt 1.00 (REFUSED 422) | — | — | — | — |
| 6 | 尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。 | (无散文) | `report_lost_card` `{"cardId":"card_credit","reason":"信用卡实体卡丢失，用户要求正式挂失并接受不可撤销"}` | `cmve17aoe00nxg0f8p241uda7` RED requiresMfa=true executed | verified attempts=0 maxAttempts=3 |
| 7 | 请为刚挂失的尾号6688信用卡补办新卡。 | (无散文) | `replace_card` `{"cardId":"card_credit"}` | `cmve17ddg00rsg0f8o0psen5z` RED requiresMfa=true (status=awaiting_mfa at park time) → executed | verified attempts=0 maxAttempts=3 |
| 8 | 确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。 | 无新的待确认动作（PASS line records `无新的待确认动作`）; no tool call emitted, no `PendingAction` created | — | none | — |

Note on row numbering: the objective's prompts 2/3 are the virtual-card lost/replace pair; the table above numbers turns as the harness does (front-end legs interleaved). All six user prompts were sent verbatim — the PASS line quotes each one; prompt 1 is the pinned `LG_VC_APPLY_PROMPT` and prompt 2 interpolates the tail (`1865`) that the new card actually received.

## Card rows (SQLite `Card`, `logs/lG-r3-db.txt`)

| id | type | status | numberMasked | linkedAccountId | replacedByCardId | creditLimitMinor / availableLimitMinor | monthlyLimitMinor |
|---|---|---|---|---|---|---|---|
| `card_credit` | CREDIT | LOST | ****6688 | — | `cmve17dmq00s6g0f84ylhf1hg` | 1800000 / 1800000 | 1800000 |
| `card_debit` | DEBIT | ACTIVE | ****8821 | — | — | null / null | null |
| `card_virtual` | VIRTUAL | ACTIVE | ****7788 | acct_checking | — | null / null | 500000 |
| `cardidem_897d995e57a05d6ab6be1c63d0a693b1` | VIRTUAL | **LOST** | ****1865 | acct_checking | `cmve1766400j3g0f8tef3dr9m` | null / null | 10000 |
| `cmve1766400j3g0f8tef3dr9m` | VIRTUAL | **ACTIVE** | (tail not transcribed in the PASS line — see DB dump) | acct_checking | — | null / null | 10000 |
| `cmve17dmq00s6g0f84ylhf1hg` | CREDIT | **ACTIVE** | ****6713 | — | — | **1800000 / 1800000** | 1800000 |

Total: 6 = baseline 3 + 1 VIRTUAL source + 1 VIRTUAL replacement + 1 CREDIT replacement (never a hardcoded total).

## Money / ledger
- `acct_checking.balanceMinor`: 2358000 → 2355000 (−30.00) → **2348000** (−70.00); unchanged by every 挂失/补办.
- `Transaction` added: exactly 2, both `channel=CARD` `direction=DEBIT`: `-3000` `cmve16zvv006vg0f8mqg2tile` (虚拟卡开卡消费验证), `-7000` `cmve177bj00jjg0f8fty42adp` (虚拟卡补办续限验证). `GET /api/bills` 新增 2 条、消失 0 条; dashboard `23480.00`.
- `CardConsumption`: exactly 2 — `cmve16zvw006wg0f809f92w9q` 3000 on `cardidem_897d…`, `cmve177bj00jkg0f8ck1vd2h9` 7000 on `cmve1766400j3…`.
- Payable (virtual family): 100.00 → 70.00 (after 30.00) → **70.00 after replacement (continuity, NOT reset)** → 0.00 (after 70.00); `1.00` then refused with `超出本月消费限额` / `422 LIMIT_EXCEEDED` and zero financial change.
- Credit available total: non-LOST = **18000.00**; naive all-CREDIT = 36000.00 explicitly excluded.

## Per-assertion verdicts — ALL PASS
| Assertion | Verdict |
|---|---|
| Every replace parked a real `replace_card` `PendingAction` tier=RED/requiresMfa=true before verification, with no new card / no status change beforehand | PASS (VC: card count still 4, source LOST; Credit: no new card, source still LOST) |
| After MFA `123456` exactly ONE new card, same type, ACTIVE, fresh number | PASS (VIRTUAL ****→new; CREDIT ****6713 ≠ ****6688) |
| Virtual replacement keeps `linkedAccountId='acct_checking'` and allowance continuity 70.00 before AND after (never 100.00) | PASS |
| Credit replacement: source `card_credit` stays LOST, new card CREDIT/ACTIVE, `replacedByCardId` link, `creditLimitMinor`/`availableLimitMinor` = 1_800_000 | PASS |
| Prompt 5 (previously refused with 「补办实体信用卡和借记卡只能在「卡片」页面手动办理」) — model actually emitted `replace_card` | **PASS — the refusal did not appear; `replace_card {"cardId":"card_credit"}` was emitted and executed** |
| Prompt 6 creates NO second replacement card (count + unique ACTIVE CREDIT id unchanged) | PASS (6 → 6; ACTIVE CREDIT remains `cmve17dmq00s6g0f84ylhf1hg`; no tool call) |
| Cash/ledger invariance across replacements; only the two consumptions moved money | PASS |
| No hardcoded card totals; baseline-derived | PASS |
| Every prose turn guarded by `assertNoFabricatedConfirmationPanel`, ≤6 turns per leg | PASS (all legs within bound; guard raised nothing) |

## Evidence (this round, never overwritten)
- `logs/lG-r3.out`, `logs/lG-r3-exitcode.txt`, `logs/lG-r3-db.txt`, `logs/lG-r3.db` (+ `-wal`/`-shm`), `logs/lG-r3-evidence.json` (harness-written), `logs/lG-r3-start.txt`, `logs/lG-r3-end.txt`, `logs/lG-r3-postcleanup.txt` — all gitignored, never committed.
- Screenshots: `output/playwright/live/lG-headacebc393-round3/01-lG-virtual-replacement.png`, `02-lG-virtual-refusal.png`, `03-lG-credit-replacement.png`.

## Cleanup proof
- `PORT 57014: NOT LISTENING (closed)`; `PID 50376 (next dev): EXITED` (`logs/lG-r3-postcleanup.txt`). Pre-run snapshot `logs/lG-r2-precleanup.txt` shows round 1's port 62493 (pid 64360) was already gone before this run.
- Residual: one `chrome.exe` (pid 54504, started 00:22:14) from the run window was still present at snapshot time — NOT resolved, recorded honestly.

## Harness fixes needed to reach this PASS (tests/e2e only; no prompts changed, no product code touched)
1. `1c674005` — `sendFinalConfirmTurn` now re-enters `/agent` before submitting (`/cards` has no composer); `applyVirtualCardViaAgent` gained an `opts.turns` override so lG sends its pinned verbatim step-1 sentence.
2. `acebc393` — step-8 VIRTUAL cardinality derived from the scenario-start baseline (seed ships `card_virtual`) instead of a hardcoded 2, plus the two chain rows pinned (source LOST / replacement ACTIVE).
