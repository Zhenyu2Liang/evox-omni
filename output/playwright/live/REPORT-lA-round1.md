# LIVE acceptance round report - scenario lA

- **Scenario id**: lA
- **Scenario name**: lA-live-credit-card-report-lost-and-replace
- **Round**: 1 of 3
- **Harness**: tests/e2e/live-acceptance.e2e.ts
- **Invocation**: $env:LIVE_SCENARIOS='lA'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
- **Model / browser**: REAL DeepSeek (LLM_MODE=live, LLM_PROVIDER=deepseek, model id from .env.local) driving REAL headless Chrome against the REAL Next dev server (free port 65533).
- **Isolated DB**: prisma/live-acceptance.db (re-provisioned via db push + tsx prisma/seed.ts; prisma/dev.db and prisma/test.db untouched).
- **Run date (UTC)**: 2026-10-16 ~19:33-19:35

## Verbatim result

```
FAIL lA-live-credit-card-report-lost-and-replace - 卡片总数应为 3，实际 4：card_credit:CREDIT:LOST,card_debit:DEBIT:ACTIVE,card_virtual:VIRTUAL:ACTIVE,cmvaw3kbs012es4f89ivec1n9:CREDIT:ACTIVE
== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==
```

- **Process exit code**: 1
- **PASS / FAIL / SKIP line**: FAIL lA-live-credit-card-report-lost-and-replace (see above)
- **helpers.ts#assertNoFabricatedConfirmationPanel fired?** NO - the model did NOT fabricate a confirmation panel; it actually executed the real RED tools (report_lost_card + replace_card) through the real gateway/MFA. No pendingAction-without-panel mismatch was reported.
- **Network / console noise**: 4xx/5xx = 0, console error = 0, pageerror = 0.
- **Infrastructure**: none - server boot, DB provisioning and browser launch all succeeded; this is a genuine scenario ASSERTION failure, not contention or timeout.

## DB cross-check (prisma/live-acceptance.db, raw values)

Card rows (bigint minor units):

| id | type | status | creditLimitMinor | availableLimitMinor | monthlyLimitMinor | linkedAccountId | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- | --- |
| card_credit | CREDIT | LOST | 1800000 | 1800000 | 1800000 | null | cmvaw3kbs012es4f89ivec1n9 |
| card_debit | DEBIT | ACTIVE | null | null | null | null | null |
| card_virtual | VIRTUAL | ACTIVE | null | null | 500000 | acct_checking | null |
| cmvaw3kbs012es4f89ivec1n9 | CREDIT | ACTIVE | 1800000 | 1800000 | 1800000 | null | null |

- **Card count**: 4
- **ACTIVE CREDIT count**: 1
- **card_credit.status / replacedByCardId**: LOST / cmvaw3kbs012es4f89ivec1n9

Dashboard summary (banking.dashboard.getDashboardSummary('user_liming'), authoritative):

```
{"totalAssets":"96920.07","checkingBalance":"23580.00","creditAvailable":"18000.00","monthSpend":"13936.05","month":"2026-09"}
```

- creditAvailable = 18000.00 (NOT doubled - the LOST source card is excluded; the SDK filters type==='CREDIT' && status!=='LOST'). totalAssets = 96920.07 (credit is not folded into assets; no doubling).

## What the journey actually proved (all substantive criteria PASSED)

The failure is raised ONLY by the total-card-count assertion at tests/e2e/live-acceptance.e2e.ts:1287-1289 (卡片总数应为 3). Every check BEFORE it passed, i.e.:

- The replacement card inherits the SAME approved credit limit (creditLimit 18000.00) - no doubling.
- The replacement card inherits the SAME current available limit (availableLimit 18000.00) - no doubling.
- The source card card_credit stays LOST / terminal and links replacedByCardId to the new card.
- Exactly ONE ACTIVE replacement credit card exists (cmvaw3kbs012es4f89ivec1n9).
- The other seeded cards (card_debit ACTIVE, card_virtual ACTIVE with monthlyLimit 5000.00 linked to acct_checking) are untouched.
- The dashboard credit-available does NOT double (18000.00).

## Root cause of the FAIL (stale, internally-contradictory assertion)

The seed now contains THREE cards (card_credit, card_debit, card_virtual); a real replace_card mints a NEW row (the source remains as a LOST row). The lA scenario itself requires the source row to still be present (source?.status !== 'LOST' check at :1265) AND a new replacement row (:1222-1232, :1257-1259), so a successful replacement necessarily yields 4 rows - yet the scenario then asserts cards.length !== 3. The === 3 total was correct only for the older 2-card seed (card_credit + card_debit); once the virtual-card fixture (prisma/seed.ts, commit 1cf220d) was added, the count assertion became stale. The same stale count appears in the idempotency leg (:1309 afterSecond.length !== 3).

This is a TEST-EXPECTATION defect, not a product defect: the product behaviour matches the documented invariant ("a replaced card is terminal (LOST) and must not be counted alongside its replacement") and the task's stated proof points.

**Not fixed in this round.** tests/CONTEXT.md already records this exact failure (tests/e2e/live-acceptance.e2e.ts ... 断言补卡后卡总数为 3) and marks it as a known issue owned by a PARALLEL WORKFLOW, read-only for this node. Per the task's "do not commit other workstreams' files" and "do not delete/skip assertions to claim a pass", the assertion was left untouched so this round stays comparable to the two concurrent rounds on the same commit. Suggested minimal fix (for the owning workflow): assert total 4 - or better, assert by type/status (1 ACTIVE CREDIT + 1 LOST CREDIT linked via replacedByCardId + 1 DEBIT + 1 VIRTUAL) instead of a bare count.

## Screenshots

Harness screenshots are written to output/playwright/live/; copied to round-specific names:

- output/playwright/live/lA-round1-cards.png - the REAL /cards page after report-lost + replace (source shows 已挂失/已补卡, replacement shows 正常 with 信用额度/可用额度 = 18,000.00).
- output/playwright/live/lA-round1-failure-fullpage.png - the harness failure-capture full-page shot.
- output/playwright/live/lA-round1-run-log.txt - verbatim run log (incl. EXITCODE=1).

## Process cleanup

- Dev server on port 65533: stopped (no listener remains).
- Playwright browser: closed in the harness finally (no chrome process started at this round's start time).
- No lingering node/chrome process from this round.

