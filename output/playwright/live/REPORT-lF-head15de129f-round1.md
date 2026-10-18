# REPORT — lF PILOT ROUND 1 (live, real model)

- Scenario: `lF` / `lF-live-credit-report-lost-and-replace-new-session`
- Certified product tree commit: **15de129f** (`git rev-parse --short HEAD` at run start; all edits in this task are `tests/e2e/*` only)
- Model: live DeepSeek `deepseek-flash` (`LLM_MODE=live` from `.env.local`, `LIVE_FORCE_MODEL` unset; harness `/api/health` reported `llmMode:"live"`)
- Isolated DB: `prisma/live-acceptance.db` (provisioned/pushed/seeded by the harness; `dev.db`/`test.db`/`e2e.db` untouched)
- Verdict round 1: **PASS**

## Command (exact)

```
$env:LIVE_SCENARIOS='lF'
cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lF-r1.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lF-r1.out & exit !EC!"
exit $LASTEXITCODE
```

## Exit-code signals (both recorded)

| signal | value |
| --- | --- |
| tool-reported process exit code (`$LASTEXITCODE` from the `cmd /v:on` wrapper) | `0` |
| `EXIT=` line inside `logs/lF-r1.out` | `EXIT=0` |

- Duration: **38 s** wall clock (whole entry: DB reset → dev server → browser → scenario → teardown)
- Summary line: `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`
- Network noise: `累计网络 4xx/5xx：0，console error：0，pageerror：0`

## Verbatim user prompts and model prose per turn

Turn 1 (挂失):
- prompt: `我的尾号6688信用卡丢失了，请正式挂失，我确认不可撤销。`
- model prose: `(无散文)`
- controlled tool call: `report_lost_card` → confirmation/MFA panel → MFA `123456`
- result: `RAW card_credit.status=LOST`

Turn 2 (补办):
- prompt: `请为刚挂失的尾号6688信用卡补办新卡。`
- model prose: `(无散文)`
- controlled tool call: `replace_card` → `/api/actions` row `cmve04mm500aov0f8hj5zur9n` (tier=RED, requiresMfa=true, status=`awaiting_mfa`; SQLite same row `status=awaiting_mfa`, `mfa=pending/0`)
- pre-verification: card count still 3, no new card, source `status=LOST`, `replacedByCardId=null`
- after MFA `123456`: exactly one new `CREDIT` card `cmve04n3r00b2v0f89am4wwf4` (RAW `status=ACTIVE`, number `****3613` ≠ `****6688`, `creditLimitMinor=1800000`, `availableLimitMinor=1800000`); source `card_credit` `status=LOST`, `replacedByCardId=cmve04n3r00b2v0f89am4wwf4`; card count 3 → 4 (baseline + 1)

No `只能手动办理` refusal appeared — the `replace_card` path is genuinely open to the model.

## Card rows and DB numbers

Before 补办 (`GET /api/cards`, 3 cards):
- `card_credit:CREDIT:LOST:可用=18000.00:被补=无`
- `card_debit:DEBIT:ACTIVE`
- `card_virtual:VIRTUAL:ACTIVE`

Money / credit invariants:
- non-LOST credit available total before 挂失 = `18000.00`; after 补办 = `18000.00` (unchanged)
- naive all-`CREDIT` total = `36000.00` — the bug signature, explicitly excluded by the scenario (rendered `36000.00` too)
- `/cards` rendered non-LOST credit available = `18000.00`; 补办 card tile 信用额度 = `¥18,000.00`, 可用额度 = `¥18,000.00`; the LOST source tile still renders `¥18,000.00` but is NOT summed
- ledger/dashboard: `dashboard 23580.00 → 23580.00`; `GET /api/bills` added `0` / removed `0` rows — a 补办 moves no money

## Evidence files

- raw stdout/stderr + `EXIT=` line: `logs/lF-r1.out` (gitignored)
- harness evidence JSON: `logs/lF-r1-evidence.json` (gitignored)
- DB dump: `logs/lF-r1-db.txt` (gitignored) — all `Card`, `PendingAction`, `MfaChallenge`, `Transaction`, `CardConsumption`, `AgentRunEvent` rows + persisted model ids
- SQLite copy: `logs/lF-r1.db` (gitignored)
- screenshots (committed): `output/playwright/live/lF-head15de129f-round1/01-lF-cards-after-lost.png`, `output/playwright/live/lF-head15de129f-round1/02-lF-cards-after-replace.png`

## Product-tree equivalence proof

```
git diff --stat 15de129f HEAD -- banking-sdk agent security planner lib app components prisma scripts
```
must be empty (recorded below; this report commit is the only later change and touches `output/` + the report only).

## Step 3 — selection sanity check (no model)

`selectedIds()` reads `LIVE_SCENARIOS`, splits on `,`, trims, drops empties; `main()` then does
`chosen = only ? SCENARIOS.filter(s => only.includes(s.id) || (s.id === '2p' && only.includes('2'))) : SCENARIOS`
and `runSeven = !only || only.includes('7')`.
Replica applied to the ids parsed out of the real source: `lF` → `chosen=['lF']`, `runSeven=false`; `__none__` → `[]`; `lF,lG` → `['lF','lG']`; `2` → `['2','2p']`.
The entry was NOT booted for `__none__`: `main()` calls `resetLiveDatabase()` and `bootDevServer(...)` BEFORE the scenario loop, so a bogus id still costs a DB reset + dev-server boot; per the objective this was skipped and documented instead.

## Honest notes / unverified

- Only ONE round was needed; no harness/model/product failure occurred, so no re-run happened.
- `lG` was NOT executed in this task (out of scope of this pilot round).
- `report_lost_card` / `replace_card` arguments were not printed verbatim by the harness summary (only prose/tool names); the persisted `PendingAction.argsJson` for both actions is in `logs/lF-r1-db.txt`.
## Appendix — DB dump section headers and model ids (from logs/lF-r1-db.txt)

```
== Card (all rows) ==
rows=4
== PendingAction (all rows) ==
rows=2
== MfaChallenge (all rows) ==
rows=2
== Transaction (all rows) ==
rows=232
== CardConsumption (all rows) ==
rows=0
== AgentRunEvent (all rows) ==
rows=392
== persisted model ids ==
model counts=[]
```
