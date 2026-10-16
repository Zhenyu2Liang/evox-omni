# LIVE browser acceptance — scenario `lA` (credit-card report-lost → replace) — consolidated report

**Objective:** real live-browser acceptance for the CREDIT-CARD report-lost → replace journey
(natural language through the REAL model + REAL buttons). 3 independent rounds, own process each,
using the REAL DeepSeek model (`LLM_MODE=live` / `LLM_PROVIDER=deepseek`) and a REAL headless Chrome
against the REAL Next dev server, on the ISOLATED DB `prisma/live-acceptance.db`. No mocks, no
response interception, no direct SDK calls in place of the front-end.

- **Scenario id:** `lA` (selected via `LIVE_SCENARIOS=lA`)
- **Scenario name:** `lA-live-credit-card-report-lost-and-replace`
- **Registered at:** `tests/e2e/live-acceptance.e2e.ts:1709` → `run: scenarioCreditReplace`
- **Harness:** `tests/e2e/live-acceptance.e2e.ts`
- **Invocation (each round):** `$env:LIVE_SCENARIOS='lA'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
- **Rounds:** 3, run in parallel in 3 separate worktrees/processes (distinct runtime ports + isolated DBs).

## Per-round results (verbatim)

All three rounds produced the SAME single failure line. Rounds were independent and each was run
exactly once (no re-run-until-pass).

### Round 1 — worktree `worker_T4_A106`, dev server port 65533

```
FAIL lA-live-credit-card-report-lost-and-replace - 卡片总数应为 3，实际 4：card_credit:CREDIT:LOST,card_debit:DEBIT:ACTIVE,card_virtual:VIRTUAL:ACTIVE,cmvaw3kbs012es4f89ivec1n9:CREDIT:ACTIVE
== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==
```

- **Exit code:** `1`
- Clarification / retry / timeout: none.
- Network/console: 4xx/5xx = 0, console error = 0, pageerror = 0.
- `assertNoFabricatedConfirmationPanel`: did NOT fire (model genuinely executed the real RED tools).

### Round 2 — worktree `worker_T4_A105`, dev server port 63523

```
FAIL lA-live-credit-card-report-lost-and-replace — 卡片总数应为 3，实际 4：card_credit:CREDIT:LOST,card_debit:DEBIT:ACTIVE,card_virtual:VIRTUAL:ACTIVE,cmvaw4yk8008qo4f8uzhf1unk:CREDIT:ACTIVE
== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==
```

- **Exit code:** `1`
- Clarification / retry / timeout: none (reached assertions in ~1 minute).
- Network/console: 4xx/5xx = 0, console error = 0, pageerror = 0.
- `assertNoFabricatedConfirmationPanel`: did NOT fire.

### Round 3 — worktree `worker_T4_A104`, dev server port 52635

```
FAIL lA-live-credit-card-report-lost-and-replace — 卡片总数应为 3，实际 4：card_credit:CREDIT:LOST,card_debit:DEBIT:ACTIVE,card_virtual:VIRTUAL:ACTIVE,cmvaw4ee600k0lkf8chxhog4f:CREDIT:ACTIVE
== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==
```

- **Exit code:** `1`
- Clarification / retry / timeout: none.
- Network/console: 4xx/5xx = 0, console error = 0, pageerror = 0.
- `assertNoFabricatedConfirmationPanel`: did NOT fire.

**Summary:** 3/3 rounds FAIL, all for the SAME single assertion (total card count), all exit code 1,
no infrastructure/contention/timeout failures. The failure is deterministic, not model flakiness.

## Root cause of the FAIL — a STALE TEST ASSERTION, NOT a product bug

The failing assertion is `tests/e2e/live-acceptance.e2e.ts:1287`:

```ts
if (cards.length !== 3) { throw new Error(`卡片总数应为 3，实际 ${cards.length}：...`); }
```

- Authored when the demo seed held only **2** cards (`card_credit` + `card_debit`), so post-replace
  `2 + 1 replacement = 3` (git blame → `3dc80a17`).
- The seed now holds **3** cards: `1cf220d` added `card_virtual` (VIRTUAL).
- `replace_card` **mints a NEW card row by design** and keeps the source as terminal `LOST`
  (`banking-sdk/card.ts`), so a successful replacement necessarily yields **4** rows.
- `3` was only tightened for DEBIT/VIRTUAL counts (`a38e2c43`) but the total was left at `3`.
- The SAME stale count repeats in the idempotency leg at `:1309` (`afterSecond.length !== 3`).

`tests/CONTEXT.md` already records this seed/assertion mismatch as a **known, unfixed issue owned by a
parallel workflow and read-only for this node**, and the task forbids committing other workstreams'
files and deleting/skipping assertions to claim a pass. The assertion was therefore left UNTOUCHED so
all 3 rounds stay comparable on the same commit; only reported here.

Suggested minimal fix (for the owning workflow): assert by type/status (1 ACTIVE CREDIT + 1 LOST CREDIT
linked via `replacedByCardId` + 1 DEBIT + 1 VIRTUAL) instead of a bare total, or bump `3` → `4` at both
`:1287` and `:1309`.

## Every substantive business criterion PASSED in all 3 rounds

All assertions BEFORE `:1287` passed (`:1244–1286`), i.e. the journey's real goals were met:

| Objective proof point | Result | Evidence |
| --- | --- | --- |
| New card inherits the SAME approved credit limit | PASS | new `creditLimitMinor = 1800000` (¥18,000.00) |
| New card inherits the SAME current available limit (**no doubling**) | PASS | new `availableLimitMinor = 1800000` |
| Source card stays LOST / terminal | PASS | `card_credit.status = LOST`, `replacedByCardId` → new card |
| Assets overview does NOT double | PASS | `GET /api/dashboard` `creditAvailable = 18000.00` |
| Exactly ONE ACTIVE replacement credit card | PASS | sole CREDIT+ACTIVE id = the minted card |
| Other demo cards untouched | PASS | `card_debit` DEBIT/ACTIVE, `card_virtual` VIRTUAL/ACTIVE (monthly 5000.00, linked `acct_checking`) |
| `/cards` real-page badges | PASS | new tile 「正常」; source tile 「已挂失」+「已补卡」 |

## DB cross-check — isolated DB `prisma/live-acceptance.db` (raw values)

`Card` rows after the journey (representative, round 1):

| id | type | status | creditLimitMinor | availableLimitMinor | monthlyLimitMinor | linkedAccountId | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- | --- |
| card_credit | CREDIT | LOST | 1800000 | 1800000 | 1800000 | null | new-card-id |
| card_debit | DEBIT | ACTIVE | null | null | null | null | null |
| card_virtual | VIRTUAL | ACTIVE | null | null | 500000 | acct_checking | null |
| new-card-id | CREDIT | ACTIVE | 1800000 | 1800000 | 1800000 | null | null |

- Card count: **4**; ACTIVE CREDIT count: **1**.
- Dashboard summary (`banking.dashboard.getDashboardSummary('user_liming')`, authoritative):

```
{"totalAssets":"96920.07","checkingBalance":"23580.00","creditAvailable":"18000.00","monthSpend":"13936.05","month":"2026-09"}
```

`creditAvailable = 18000.00` proves NO doubling (the LOST source card is excluded: sum of
`availableLimitMinor` over CREDIT cards with `status !== 'LOST'`). `totalAssets` confirms credit is not
folded into assets. Fresh card ids per round (minted by the model's gateway-executed `replace_card`):
round1 `cmvaw3kbs012es4f89ivec1n9`, round2 `cmvaw4yk8008qo4f8uzhf1unk`, round3 `cmvaw4ee600k0lkf8chxhog4f`.

## Screenshots

`output/playwright/live/` (round-specific names contain the journey + round):

- `lA-round1-cards.png` — real `/cards` page after report-lost + replace (source 已挂失/已补卡, replacement 正常).
- `lA-round1-failure-fullpage.png` — harness failure-capture full-page shot.
- `lA-round1-run-log.txt` — verbatim run log (incl. `EXITCODE=1`).
- `lA-round2-cards.png` / `lA-round2-failure.png` — round 2 `/cards` page and failure shot.
- `lA-round3-cards.png` — round 3 `/cards` page.
- `01-lA-cards.png`, `01-lA-credit-report-lost-and-replace.png` — harness raw artifacts (generic names).

## Process cleanup

- No listeners remain on the round ports 65533 / 63523 / 52635.
- No headless/playwright chrome and no `next dev` / `tsx live-acceptance` node process remains.
- The harness `finally` `await browser.close()` and `teardown()` stop the server + browser per round.

## Unresolved items

1. `tests/e2e/live-acceptance.e2e.ts:1287` (and `:1309`) stale card-count assertion (`3` should be `4`)
   — owned by the parallel seed/virtual-card workflow; **NOT changed here**. Until fixed, scenario `lA`
   cannot overall PASS.
2. Because the run throws at `:1287`, the idempotency leg (`:1295–:1314`, second `replace_card` must
   not mint a second card) was **never reached** — its outcome is unverified.
3. The harness never navigates to `/overview`, so "the assets overview does not double" is evidenced
   only via the `creditAvailable` recomputation (¥18,000.00), not by a page assertion.

## Provenance

Merged into branch `evogit-agent-T4-A102` from the three round branches:
round1 `evogit-agent-T4-A106` (HEAD `3e17a3f`), round2 `evogit-agent-T4-A105` (HEAD `ee3e1fe`),
round3 `evogit-agent-T4-A104` (HEAD `63230dc`). Per-round detail: `REPORT-lA-round1.md`,
`REPORT-lA-round2.md`, `REPORT-lA-round3.md`.