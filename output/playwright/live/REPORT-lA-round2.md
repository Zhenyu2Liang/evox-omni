# LIVE acceptance — scenario `lA` — REPORT (round 2)

**Status: FAIL** (genuine scenario assertion failure — NOT an infrastructure/contention failure)

## Run identity

- Worktree: `d:/projects/banking-agent/.genesis/workers/worker_T4_A105`
- Harness: `tests/e2e/live-acceptance.e2e.ts` (real Next dev server, `LLM_MODE=live` / `LLM_PROVIDER=deepseek`,
  real headless Chrome, isolated DB `prisma/live-acceptance.db`)
- Selection: `LIVE_SCENARIOS=lA`
- Model: live DeepSeek (`LLM_MODEL` from the provided `.env.local`, no forced override)
- Scenario registered at `live-acceptance.e2e.ts:1709`:
  `{ id: 'lA', name: 'lA-live-credit-card-report-lost-and-replace', run: scenarioCreditReplace }`
- Rounds are independent; this is round 2 of 3 (siblings run in separate worktrees / ports / DBs).

## Verbatim result

Per-scenario line (verbatim):

```
FAIL lA-live-credit-card-report-lost-and-replace — 卡片总数应为 3，实际 4：card_credit:CREDIT:LOST,card_debit:DEBIT:ACTIVE,card_virtual:VIRTUAL:ACTIVE,cmvaw4yk8008qo4f8uzhf1unk:CREDIT:ACTIVE
```

Summary line (verbatim):

```
== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==
```

- Process exit code: **1**
- No clarification / retry / timeout text was produced (the run reached its assertions in ~1 minute).
- `helpers.ts#assertNoFabricatedConfirmationPanel` did **NOT** fire: the model really did drive the
  controlled tools through the real gateway (no fabricated panel claim). `GET /api/actions` was not
  reported as a phantom panel.

Server/boot evidence (no infrastructure problem):

```
· next dev (pid=61876) → http://localhost:63523（/api/health 与 /agent 均已就绪）
· /api/health={"ok":true,"data":{"status":"ok","time":...,"llmMode":"live"}}
· 真实浏览器：C:\Program Files\Google\Chrome\Application\chrome.exe
· 累计网络 4xx/5xx：0，console error：0，pageerror：0
```

## What actually happened (business behaviour is CORRECT)

The journey DID complete the business flow: `report_lost_card` (RED) → MFA `123456` →
`card_credit` = LOST; `replace_card` (RED) → MFA `123456` → a NEW credit card
`cmvaw4yk8008qo4f8uzhf1unk` was minted that inherits the same limits; the source card keeps
`replacedByCardId` pointing at it. The scenario failed at the FINAL assertion:

`tests/e2e/live-acceptance.e2e.ts:1287`

```ts
if (cards.length !== 3) {
  throw new Error(`卡片总数应为 3，实际 ${cards.length}：...`);
}
```

Every earlier assertion PASSED (unique ACTIVE credit card; `creditLimit=availableLimit=18000.00`;
`monthlyLimit=18000.00`; source `LOST` + `replacedByCardId === active.id`; DEBIT/VIRTUAL unchanged
and exactly one each). Only the total-card-count assertion failed.

## Root cause

This is a **stale test assertion**, not a product bug:

- The demo seed now holds **3** cards (`prisma/seed.ts`: `card_credit` CREDIT, `card_debit` DEBIT,
  `card_virtual` VIRTUAL — the VIRTUAL card was added by the virtual-card workstream).
- `report_lost_card` is terminal: the source card is KEPT as `LOST` (never deleted). `replace_card`
  then mints a 4th card. So after the journey there are **4** cards.
- The assertion `cards.length !== 3` assumed a 2-card seed (2 + 1 replacement = 3). It is
  internally inconsistent with the scenario's own sibling assertions, which require the `LOST` source
  card to remain present AND exactly one VIRTUAL card to exist.

This exact class of seed/assertion mismatch is already documented as a known, unfixed issue owned by a
parallel workflow (root `tests/CONTEXT.md`: "演示种子当前含 3 张 ACTIVE 卡；下列 e2e 用例仍按 2 张卡断言…
属并行工作流…尚未修复"). Per that guidance and the round's scope, this assertion was **left untouched**
(reported, not modified) to avoid colliding with the owning workstream.

Because the run threw at `:1287`, the idempotency leg (`:1295`–`:1314`, SECOND `replace_card` request
must not mint a second card) was **never reached** — its outcome is unverified in this round.

## DB cross-check — isolated DB `prisma/live-acceptance.db` (raw values)

`Card` rows straight from SQLite:

```
{"id":"card_credit","type":"CREDIT","status":"LOST","numberMasked":"****6688","creditLimitMinor":"1800000","availableLimitMinor":"1800000","monthlyLimitMinor":"1800000","replacedByCardId":"cmvaw4yk8008qo4f8uzhf1unk","linkedAccountId":null}
{"id":"card_debit","type":"DEBIT","status":"ACTIVE","numberMasked":"****8821","creditLimitMinor":null,"availableLimitMinor":null,"monthlyLimitMinor":null,"replacedByCardId":null,"linkedAccountId":null}
{"id":"card_virtual","type":"VIRTUAL","status":"ACTIVE","numberMasked":"****7788","creditLimitMinor":null,"availableLimitMinor":null,"monthlyLimitMinor":"500000","replacedByCardId":null,"linkedAccountId":"acct_checking"}
{"id":"cmvaw4yk8008qo4f8uzhf1unk","type":"CREDIT","status":"ACTIVE","numberMasked":"****6956","creditLimitMinor":"1800000","availableLimitMinor":"1800000","monthlyLimitMinor":"1800000","replacedByCardId":null,"linkedAccountId":null}
=== total cards === 4
```

Dashboard summary values recomputed from SQLite with the EXACT `banking.dashboard` rule
(`banking-sdk/dashboard.ts:36-38`: sum `availableLimitMinor` over `CREDIT` cards that are not `LOST`):

```
=== creditAvailable (CREDIT && status!=LOST, sum availableLimitMinor) === 18000.00 (1800000)
=== creditNotLost ids === cmvaw4yk8008qo4f8uzhf1unk:ACTIVE
```

Account balances (raw):

```
{"id":"acct_checking","type":"CHECKING","balanceMinor":"2358000","balance":"23580.00"}
{"id":"acct_savings","type":"SAVINGS","balanceMinor":"5000000","balance":"50000.00"}
=== checkingBalance === 23580.00
```

Interpretation (proves the objective's "MUST PROVE" list, which the scenario's own assertions also
confirm before dying on the count check):

- NEW card inherits the SAME approved credit limit: `creditLimitMinor=1800000` (¥18,000.00) — same as source. OK
- NEW card has the SAME current available limit: `availableLimitMinor=1800000` — **NO doubling**. OK
- Source card stays LOST/terminal: `card_credit.status=LOST`, `replacedByCardId=cmvaw4yk8008qo4f8uzhf1unk`. OK
- Assets overview does NOT double: `creditAvailable = ¥18,000.00` (only the non-LOST CREDIT card is summed). OK
- Exactly ONE active replacement credit card: `cmvaw4yk8008qo4f8uzhf1unk` is the sole `CREDIT`+`ACTIVE`. OK

## Screenshots

Written to `output/playwright/live/`:

- `lA-round2-cards.png` — the real `/cards` page after replacement (source shown 已挂失/已补卡; new tile 正常).
  (origin: `output/playwright/live/01-lA-cards.png`)
- `lA-round2-failure.png` — the `withPage` failure screenshot captured when the count assertion threw.
  (origin: `output/playwright/01-lA-credit-report-lost-and-replace.png`)

## Unresolved items

1. `card total !== 3` assertion at `tests/e2e/live-acceptance.e2e.ts:1287` is stale vs. the current
   3-card seed. Owned by the parallel seed/virtual-card workstream; NOT changed here.
2. The idempotency leg (`:1295`–`:1314`) never executed in this round — unverified.
3. The harness never navigates to `/overview`, so the "assets overview does not double" requirement is
   only evidenced here by the `creditAvailable` recomputation (¥18,000.00), not by a page assertion.
