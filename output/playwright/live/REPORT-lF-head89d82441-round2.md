# REPORT — lF ROUND 2 (live, real model)

- Scenario: `lF` / `lF-live-credit-report-lost-and-replace-new-session`
- Certified product tree commit: **89d82441** (`git rev-parse --short HEAD` at the START of this round; the worktree was clean — `git status --porcelain` empty)
  - The product code is byte-identical to round 1's certified tree **15de129f** (proof in "Product-tree equivalence" below); only `output/` evidence was added in between.
- Model: live DeepSeek `deepseek-flash` — `/api/health` reported `llmMode:"live"` and the persisted `AgentRunEvent` rows prove the model id (see "Model id evidence")
- Isolated DB: `prisma/live-acceptance.db` — freshly deleted, `prisma db push`-ed and re-seeded by the harness at the start of this round (never `dev.db` / `test.db` / `e2e.db`)
- Verdict round 2: **PASS**

## Command (exact)

```
$env:LIVE_SCENARIOS='lF'
cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lF-r2.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lF-r2.out & exit !EC!"
exit $LASTEXITCODE
```

Runs were strictly serial: round 2 started and finished before round 3 was launched (single shared `prisma/live-acceptance.db`).

## Exit-code signals (both recorded)

| signal | value |
| --- | --- |
| tool-reported process exit code (`$LASTEXITCODE` of the `cmd /v:on` wrapper) | **`0`** |
| `EXIT=` line inside `logs/lF-r2.out` (line 16) | **`EXIT=0`** |

Measurement method was calibrated in this worktree BEFORE the round (CONTEXT.md rule): `logs/_cal7.mjs` = `process.exit(7)` and `logs/_cal0.mjs` = `process.exit(0)` were run through the identical wrapper — `EXIT=7`/tool code `7` and `EXIT=0`/tool code `0` (`logs/_cal_signal.txt`). The method therefore reports a non-zero code and does not always report zero.

- Start (local): `2026-10-19T00:03:44` (logs/_r2_start.txt)
- End (local): `2026-10-19T00:04:30` (logs/_r2_end.txt)
- Duration: **42.2 s** tool-measured wall clock for the whole entry (DB reset → `db push` → seed → dev server → browser → scenario → teardown); ~46 s including the evidence copies
- Summary line (line 15 of `logs/lF-r2.out`): `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`
- Health evidence line (line 8 of `logs/lF-r2.out`): `· /api/health={"ok":true,"data":{"status":"ok","time":1792339447971,"llmMode":"live"}}`

## Verbatim user prompts and model prose per turn

Turn 1 (挂失):
- prompt: `我的尾号6688信用卡丢失了，请正式挂失，我确认不可撤销。`
- model prose: `我先确认一下这张卡的信息。`
- controlled tool calls: `describe_turn({operations:["report_lost_card"],purpose:"operation"})` then `report_lost_card({cardId:"card_credit",reason:"用户卡片丢失，要求正式挂失（不可撤销）"})` → confirmation/MFA panel → MFA `123456`
- result: `RAW card_credit.status=LOST`, card count 3 → 3

Turn 2 (补办) — SINGLE turn, no nudge needed:
- prompt: `请为刚挂失的尾号6688信用卡补办新卡。`
- model prose: `(无散文)` — the model emitted the controlled tool call directly, no narration and no manual-only refusal
- controlled tool calls: `describe_turn({operations:["replace_card"],purpose:"operation"})` then `replace_card({cardId:"card_credit"})` → `__SECURITY_BLOCK__{actionId, decisionKind:"require_mfa"}` → `/api/actions` decision row

No `只能手动办理` / manual-only refusal appeared: `replace_card` is genuinely callable by the model.

## Parked RED action, persisted rows, and pre-verification state

`replace_card` `PendingAction` (from `/api/actions` and from SQLite, same row):

| field | value |
| --- | --- |
| id | `cmve0n23c009gfof8oc9jb6zd` |
| toolName | `replace_card` |
| status (parked, before MFA) | `awaiting_mfa` |
| tier / riskLevel | `RED` / `RED` |
| requiresMfa | `true` |
| argsJson (persisted) | `{"cardId":"card_credit"}` |
| summary field 卡片 / 风险等级 | `信用卡 ****6688` / `🔴 红色` |
| mfa challenge (parked) | `cmve0n23d009hfof8j4akgxye` status=`pending` attempts=0 maxAttempts=3 |

`report_lost_card` `PendingAction` (earlier turn, same run):

| field | value |
| --- | --- |
| id | `cmve0mtl1005lfof8p2unvw0n` |
| toolName | `report_lost_card` |
| status | `executed` (after its own MFA) |
| tier / requiresMfa | `RED` / `true` |
| argsJson | `{"cardId":"card_credit","reason":"用户卡片丢失，要求正式挂失（不可撤销）"}` |
| mfa | `cmve0mtl5005mfof84wgq28tf` status=`verified` attempts=0 maxAttempts=3 |

Final MFA rows in SQLite (`logs/lF-r2-db.txt`): both challenges `status=verified`, `attempts=0`, `maxAttempts=3` — only the correct code `123456` was ever submitted.

PRE-VERIFICATION (asserted while the action was still parked, before any code was entered — harness evidence `preVerification`):

```json
{ "cardCount": 3, "sourceStatus": "LOST", "sourceReplacedByCardId": null, "newlyCreatedCardIds": [] }
```

⇒ at that moment: **no new card existed**, the card count was unchanged (3), and the source card was still `LOST` with no replacement link.

## Card rows — before and after

Before 挂失 (`GET /api/cards`, 3 cards, seed):

| id | type | status | numberMasked | replacedByCardId | creditLimitMinor | availableLimitMinor |
| --- | --- | --- | --- | --- | --- | --- |
| `card_credit` | CREDIT | ACTIVE | `****6688` | null | 1800000 | 1800000 |
| `card_debit` | DEBIT | ACTIVE | `****8821` | null | null | null |
| `card_virtual` | VIRTUAL | ACTIVE | `****7788` | null | null | null (monthlyLimitMinor 500000, linkedAccountId `acct_checking`) |

After 挂失 (`GET /api/cards`, still 3 cards): `card_credit` → `CREDIT`/**`LOST`** (limit fields kept, `replacedByCardId` still null), `card_debit` / `card_virtual` unchanged.

After MFA `123456` (补办) — RAW `Card` rows straight from SQLite (`logs/lF-r2-db.txt`), 4 rows = baseline + 1:

| id | type | status | numberMasked | replacedByCardId | creditLimitMinor | availableLimitMinor |
| --- | --- | --- | --- | --- | --- | --- |
| `card_credit` (source) | CREDIT | **LOST** | `****6688` | `cmve0n2z1009ufof84bgdlc5k` | 1800000 | 1800000 |
| `card_debit` | DEBIT | ACTIVE | `****8821` | null | null | null |
| `card_virtual` | VIRTUAL | ACTIVE | `****7788` | null | null | null |
| `cmve0n2z1009ufof84bgdlc5k` (new) | CREDIT | **ACTIVE** | **`****7720`** (≠ `****6688`) | null | **1800000** (inherited) | **1800000** (inherited) |

Exactly one new `CREDIT`/`ACTIVE` card; it is the only `ACTIVE` credit card; there are exactly 2 `CREDIT` rows (1 `LOST` source + 1 replacement).

## DB money numbers

- `acct_checking.balanceMinor = 2358000` ⇒ **`dashboard 23580.00`** — unchanged before/after 挂失 and 补办 (`23580.00 → 23580.00`)
- non-`LOST` credit available total: **`18000.00` before 挂失** and **`18000.00` after 补办** (unchanged, counted once)
- naive total over ALL `CREDIT` rows (LOST source included): **`36000.00`** — recorded as the excluded BUG SIGNATURE (rendered `36000.00` too, and explicitly not summed)
- after 挂失 only the `LOST` source remained, so the non-`LOST` total was `0.00` for that intermediate step (harness line: `非 LOST 可用合计 0.00、朴素全 CREDIT 合计 18000.00`)
- `/cards` rendered: replacement tile 信用额度 `¥18,000.00`, 可用额度 `¥18,000.00`; non-`LOST` rendered credit total `18000.00`; naive rendered `36000.00`
- `GET /api/bills`: added **0** rows / removed **0** rows — a 补办 moves no money
- `Transaction` rows = 232 (seed only), `CardConsumption` rows = 0 — no ledger side effect from 挂失/补办

## Invariant checklist (round 2)

| invariant | result | evidence |
| --- | --- | --- |
| `replace_card` `PendingAction` with `tier=RED`, `requiresMfa=true`, status pending/awaiting_mfa, BEFORE any card is created | **PASS** | `cmve0n23c009gfof8oc9jb6zd` parked `awaiting_mfa`, RED, requiresMfa true; `preVerification.cardCount=3`, `newlyCreatedCardIds=[]`, `sourceStatus=LOST`, `sourceReplacedByCardId=null` |
| no new card and no status change at that moment | **PASS** | same `preVerification` block; card count still 3 |
| after MFA `123456`: exactly ONE new CREDIT ACTIVE card | **PASS** | `cmve0n2z1009ufof84bgdlc5k` `CREDIT`/`ACTIVE`; 2 `CREDIT` rows total; unique ACTIVE credit card |
| fresh masked number ≠ `****6688` | **PASS** | `****7720` |
| source `card_credit` stays `LOST` with `replacedByCardId` → new card | **PASS** | `status=LOST`, `replacedByCardId=cmve0n2z1009ufof84bgdlc5k` |
| `creditLimitMinor`/`availableLimitMinor` = `1_800_000` inherited unchanged | **PASS** | both `1800000` in the RAW row and `¥18,000.00` / `¥18,000.00` rendered |
| card count = baseline + 1 | **PASS** | 3 → 4 |
| credit available NOT doubled: non-LOST CREDIT total `18000.00` before and after | **PASS** | `18000.00` → `18000.00` |
| naive all-CREDIT `36000.00` recorded as excluded bug signature | **PASS** | DB `naiveAllCreditAvailableMinor=3600000`; rendered naive `36000.00` rejected as the answer |
| cash/ledger invariance: dashboard `23580.00` unchanged, `/api/bills` added 0 / removed 0 | **PASS** | `dashboard=23580.00` before/after; `新增 0 条/消失 0 条` |
| no manual-only refusal: the model actually emitted `replace_card` | **PASS** | `tool_execution_start` for `replace_card` (sequence 104) + parked `PendingAction`; no `只能手动办理` text in any assistant turn |

## Model id evidence (persisted rows, not just env)

`logs/lF-r2-db.txt` (round 1's dump printed `model counts=[]` — fixed for this round):

```
== persisted model ids (AgentRunEvent eventType=provider_request_payload, payloadJson.payload.model) ==
providerRequestPayloadRows=5
distinctModelRequestsWithProviderPayload=5
unparsablePayloads=0 payloadsWithoutPayloadModel=0
model counts=[["deepseek-flash",5]]
```

The extraction reads `AgentRunEvent.payloadJson.payload.model` (the journal wraps provider evidence as
`{ modelRequestId, payload }`), which is why round 1's path produced an empty list. `ModelRequest` rows in the
same dump are all `status=completed` (5/5), no `errorCode`.

## Evidence files (round 2)

Gitignored, never committed:

- raw stdout/stderr + `EXIT=`: `logs/lF-r2.out` (16 lines; summary line 15, `EXIT=0` line 16)
- harness evidence JSON: `logs/lF-r2-evidence.json`
- DB dump: `logs/lF-r2-db.txt` (Account, all `Card`, `PendingAction` + `MfaChallenge`, newest 20 `Transaction` of 232, `CardConsumption`, all `AgentRunEvent` + event-type histogram, persisted model ids, `ModelRequest` rows)
- SQLite copy of the round-2 database: `logs/lF-r2.db` (sidecars `-wal`/`-shm` when present)
- DB dump tool output: `logs/lF-r2-dump.out`, `EXIT=0`

Committed (this round only):

- `output/playwright/live/lF-head89d82441-round2/01-lF-cards-after-lost.png`
- `output/playwright/live/lF-head89d82441-round2/02-lF-cards-after-replace.png`

Screenshots were copied immediately after the run, before round 3 could overwrite the harness's fixed filenames.

## Product-tree equivalence

The round certifies product tree `89d82441`. Because recording evidence advances `HEAD`, the proof is:

```
git diff --stat 89d82441 HEAD -- banking-sdk agent security planner lib app components prisma scripts
```

must be empty. Additionally, the same product bytes as round 1's certified tree:

```
git diff --stat 15de129f HEAD -- banking-sdk agent security planner lib app components prisma scripts
```

Both were run before and after the evidence commit; outputs are recorded in the follow-up proof commit of this file and in `logs/_r2_proof_pre.txt` / `logs/_r2_proof_post.txt`.

## Honest notes

- This round needed only ONE attempt and produced no model non-determinism: both business legs parked a real RED action on the first natural-language turn (the 补办 turn emitted `replace_card` directly with no prose).
- The 挂失 turn produced one short prose line (`我先确认一下这张卡的信息。`) before the controlled call; it did not claim a panel existed, so `assertNoFabricatedConfirmationPanel` accepted it.
- `lG` was not run in this round (out of scope).
- The DB dump script (`logs/lF-dbdump.ts`, gitignored) is ad-hoc tooling created in this worktree; it is not part of the test suite.
