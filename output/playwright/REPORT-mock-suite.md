# Non-live baseline — mock browser suite (`tests/e2e/acceptance.e2e.ts`)

Evidence-only run of the offline (mock-model) browser acceptance suite at current HEAD.
No product code was changed, no assertion was weakened, skipped or deleted, and
`tests/e2e/CONTEXT.md` / `tests/e2e/LIVE-ACCEPTANCE-REPORT.md` were left untouched.

## Run identity

| Item | Value |
| --- | --- |
| Commit SHA tested (`git rev-parse HEAD`) | `62392c0740673e2a79cf83ac0df5784e4780422a` |
| Harness | `tests/e2e/acceptance.e2e.ts` |
| Exact command | `pnpm exec tsx tests/e2e/acceptance.e2e.ts` |
| Model mode | mock (`LLM_MODE=mock`, asserted by the harness through `GET /api/health` → `llmMode: "mock"`) |
| Browser | real headless Chrome — `C:\Program Files\Google\Chrome\Application\chrome.exe` (`playwright-core`, no bundled download) |
| Isolated DB | `prisma/e2e.db` (sidecars `-wal`/`-shm`); never `prisma/dev.db`, never `prisma/test.db` |
| DB lifecycle | deleted + `prisma db push` + probe + `tsx prisma/seed.ts` before boot, then reseeded between journeys |
| Dev server | real `next dev` on a dynamic free port — this run: `pid=59860 → http://localhost:55155` |
| Full stdout/stderr | `logs/mock-suite-head.log` (gitignored) |
| Exit code | **0** — read from the entry's own process exit status (delayed-expansion `!ERRORLEVEL!` recorded `EXIT=0`), and the summary line reports 0 failures, so exit code and PASS line agree |

This report certifies commit `62392c0740673e2a79cf83ac0df5784e4780422a`.
`git diff 7a7a4d32a6a1622deb7647ab6142fb7991b76805 62392c0740673e2a79cf83ac0df5784e4780422a` touches only
`output/playwright/live/` evidence files, so the product code and the `tests/e2e/**` assertions exercised here are the
same as at `7a7a4d3`.

## Summary line (verbatim)

```
== 汇总：PASS 23 ｜ FAIL 0 ｜ SKIP 0 ==
```

Head of the log (verbatim), showing the isolated-DB and server banner:

```
== AI Banking Agent 真实浏览器端到端验收 (tests/e2e) ==
· 隔离 E2E 数据库：file:D:/projects/banking-agent/.genesis/workers/worker_T5_A46/prisma/e2e.db（prisma/dev.db 不受影响）
Reset isolated E2E database: generate the client if needed, remove the file and sidecars, push the schema, probe, then seed.
· next dev (pid=59860) → http://localhost:55155（/api/health 与 /agent 均已就绪，LLM_MODE=mock）
· 真实浏览器：C:\Program Files\Google\Chrome\Application\chrome.exe
```

## Per-journey verdicts (23 / 23 PASS)

| # | Journey id | Verdict |
| --- | --- | --- |
| 1 | `chat-history-pagination-and-scroll` | PASS |
| 2 | `signed-amount-memory-and-subscription-analysis` | PASS |
| 3 | `operation-history-and-developer-audit` | PASS |
| 4 | `natural-conversation-and-financial-boundary` | PASS |
| 5 | `manual-card-management-and-agent-boundary` | PASS |
| 6 | `contacts-and-investment-pages` | PASS |
| 7 | `multi-card-freeze-audit-history` | PASS |
| 8 | `developer-mode-conversation-controls` | PASS |
| 9 | `subscription-tool-lifecycle` | PASS |
| 10 | `shared-demo-dialogue-and-browsers` | PASS |
| 11 | `hydration-external-root-attribute` | PASS |
| 12 | `i18n-chinese-default-and-switching` | PASS |
| 13 | `workspace-http-and-mobile` | PASS |
| 14 | `a-transfer-confirm` | PASS |
| 15 | `b-transfer-mfa` | PASS |
| 16 | `c-plan-pause-resume` | PASS |
| 17 | `d-plan-cancel` | PASS |
| 18 | `e-refresh-action-recovery` | PASS |
| 19 | `f-wedge-refresh-recover` | PASS |
| 20 | `g-manual-handoff` | PASS |
| 21 | `h-investment-flow` | PASS |
| 22 | `i-anomaly-detection` | PASS |
| 23 | `j-circuit-breaker-lock` | PASS |

### Verbatim assertion text — money-moving and risk journeys

```
PASS a-transfer-confirm — 「给张伟转200元」→ 确认卡(确认/取消) → 确认 → 助手「转账处理结果：」；余额 23580.00 → 23380.00（−200.00），账本新增 -200.00 DEBIT（转账给张伟）
PASS b-transfer-mfa — 正确码：正确验证码 123456 → 助手「转账处理结果：」；余额 23580.00 → 21580.00（−2000.00），账本新增 -2000.00 DEBIT（张伟） ｜ 错误码：错误验证码 000000 → role=status「验证失败，已尝试 1 次」，MFA 卡片保留，无成功叙述；余额/账本均未变
PASS c-plan-pause-resume — 门控计划 → 等待确认 → 点击「暂停」→ 已暂停（节点「调整」保持「待确认」、娱乐限额 3000.00 未变、无后续节点执行）→ 点击「继续」→ 等待确认（已完成节点「查询消费情况」仍「成功」、未重跑；剩余节点重新停在「待确认」）
PASS d-plan-cancel — 门控计划 → 等待确认 → 计划卡「取消」→ 已取消 ｜ 确认卡片已由 DOM 移除（「确认」按钮计数 0）且挂起动作已不在非终态集合 ｜ 余额(23580.00)/账本/娱乐限额(3000.00) 均未变
PASS e-refresh-action-recovery — YELLOW：YELLOW 把信用卡娱乐限额调整到1500元: reload restores the inline confirmation from persisted actions ｜ RED：RED 转账挂起 → 同一 context reload → MfaCard(身份验证) 恢复
PASS f-wedge-refresh-recover — Conversation reload restores recovery; committed receipt settles once, balance 23580.00 -> 23380.00, new debit count 1, action executed, audit success
PASS g-manual-handoff — 失败任务→转人工→刷新保留→阻止直接重试→记录处理人/说明→继续后仍待用户确认；未知结果只登记/结束，保留待核对状态；两阶段审计齐全
PASS h-investment-flow — 「申购稳健理财A 1000元」→ MFA 123456 → 助手「理财申购结果：」；「赎回稳健理财A」→ MFA 123456 → 助手「理财赎回结果：」；账本 category=投资 认购稳健理财A -1000.00（DEBIT）/ 赎回 +6178.36（CREDIT）
PASS i-anomaly-detection — 帮我看有没有异常消费: 可疑交易提醒 / Apple Store / -¥6,999.00 / 低风险; 1 matching debit anomaly; no false clean result
PASS j-circuit-breaker-lock — Session demo:user_liming: normal mode hides and denies developer reset; three wrong payment codes lock the owner across reload; one developer button resets without credentials and records SECURITY_RESET
```

### Verbatim assertion text — authorization-panel / durability / UI journeys

```
PASS chat-history-pagination-and-scroll — Latest twenty messages render complete replies; earlier pages preserve anchors, drafts and preferences; failures retry without loss; new content offers a latest button; refresh and another browser use bounded history; a reset fences delayed pages.
PASS signed-amount-memory-and-subscription-analysis — Negative money is refused before a lookup or model write; exact signed wording survives recall and reload; previous subscription results support natural analysis without generic safety prose, new authorizations, data changes or browser errors.
PASS operation-history-and-developer-audit — Ordinary operation history omits tool internals; raw audit HTML/RSC/API is gated; developer opt-in survives reload, remains browser-local, and disabling exits audit; mobile business records fit 320px.
PASS natural-conversation-and-financial-boundary — Funding explanation, small talk and scheduled-task capability questions produce distinct natural answers; no writes, plans or authorization appear; an old draft is not resumed; refresh preserves answers; a later explicit transfer still requires confirmation; no browser errors.
PASS manual-card-management-and-agent-boundary — Manual card addition/deletion require reviewed details and separate MFA; wrong codes/cancellation do not mutate; refresh resumes; repeats preserve one receipt/audit; Agent virtual-card application is RED-verified while physical creation/deletion stay manual; schedule redirect is removed.
PASS contacts-and-investment-pages — Separate approval navigation is removed; contact add/delete persists across reload and browsers with masked phones and audits; investment products show exact money, rates and risk without mobile overflow.
PASS multi-card-freeze-audit-history — Three cards each require a separate RED challenge in a mobile-safe dock outside the transcript; pending reload preserves the request without its code, wrong codes retain pending status, successful verification dismisses each request and preserves read-only approval transitions; completed plans keep their original message placement.
PASS developer-mode-conversation-controls — Normal chat survives refresh; developer tools are opt-in; clear requires confirmation, resets shared context, preserves ledger/run evidence, and works through the mobile modal.
PASS subscription-tool-lifecycle — Subscription approval stays outside the transcript, fits mobile and survives pending reload; confirmation dismisses the dock and preserves previous/current states in a read-only receipt; results remain business cards and later turns never flash stale activity. Screenshot: D:\projects\banking-agent\.genesis\workers\worker_T5_A46\output\playwright\19-subscription-tool-lifecycle.png
PASS shared-demo-dialogue-and-browsers — Browsers share a server-selected conversation without login; greetings, negative corrections, ambiguous card changes and confirmation advance distinctly; a later balance query works and clarification never changes the ledger
PASS hydration-external-root-attribute — Clean and externally modified root elements hydrate without console errors; language switching and drafts work; descendant mismatches still report diagnostics
PASS i18n-chinese-default-and-switching — Chinese defaults despite an English browser preference; desktop and mobile switching translates server pages, persists across reloads, preserves drafts and message identities, and submits no additional banking operation
PASS workspace-http-and-mobile — Root opens the assistant; UUID fallback sends once; suggestions and IME preserve drafts; grouped sidebar and 390/320px mobile navigation work; balance read leaves the ledger unchanged
```

## Exact numeric assertions captured this run

All money values below are the harness's own rendered-DOM + read-route cross-checks, verbatim:

| Assertion | Value |
| --- | --- |
| Seed `acct_checking` balance | `23580.00` CNY |
| `a-transfer-confirm` after confirm | balance `23580.00 → 23380.00` (−200.00), one new DEBIT `-200.00` |
| `b-transfer-mfa` wrong code `000000` | `验证失败，已尝试 1 次`, MFA card retained, balance/ledger unchanged (`23580.00`) |
| `b-transfer-mfa` correct code `123456` | balance `23580.00 → 21580.00` (−2000.00), one new DEBIT `-2000.00` |
| `d-plan-cancel` | balance `23580.00` unchanged, 娱乐限额 `3000.00` unchanged, confirm-button count `0` |
| `c-plan-pause-resume` | 娱乐限额 `3000.00` unchanged while paused; completed node not re-run |
| `f-wedge-refresh-recover` | balance `23580.00 → 23380.00`, new debit count `1` (receipt settles once) |
| `h-investment-flow` | 认购稳健理财A `-1000.00` (DEBIT, category=投资); 赎回 `+6178.36` (CREDIT) |
| `i-anomaly-detection` | `Apple Store / -¥6,999.00 / 低风险`, exactly `1` matching debit anomaly |

## Screenshots

Written to `output/playwright/` (gitignored), including the
`19-subscription-tool-lifecycle.png` referenced inside that journey's PASS line.
This baseline record does not re-commit screenshots; the committed set under
`output/playwright/` already exists from earlier runs.

## Not verified by this run

- No live model was exercised: `tests/e2e/live-acceptance.e2e.ts` was **not** run in this task, so nothing here
  speaks to real-model stability, latency, refusal behaviour or `driveRedTool` natural-language loops.
- No production build (`pnpm build`) / deployment, no cluster concurrency, no real banking rail.
- Multi-browser sharing is asserted only inside this harness's own browser contexts.
- Vitest layers (`tests/unit`, `tests/scenarios`, `tests/app`, `tests/integration`) were not run here.
