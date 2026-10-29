# 真实模型验收证据

本文件保留历史验收结论，不代表当前版本已通过验收。
下文的 `output/playwright/` 路径对应历史产物，已从当前源码树移除。
历史文件可从清理前的提交读取：

```sh
git ls-tree -r 0fd9a38f -- output/playwright
git show 0fd9a38f:output/playwright/REPORT-mock-suite.md
```

当前验收入口与记录要求见[测试用例](../../docs/cn/test-cases.md)。

## 安全修复验证

执行日期为 `2026-10-28`，文档核对日期为 `2026-10-29`。
银行和 MFA 均使用隔离数据库中的模拟服务。
真实模型为现有配置的 DeepSeek / `deepseek-flash`。
浏览器验收使用真实 Chrome 和 `next start` 生产服务。

产品树包含当时的未提交修改，不能只用 HEAD 表示。
最终运行代码的 476 个文件记录在[文件清单](../../.local/security-audit/fixes/source-manifest-final.json)中。
文档核对时，清单中的文件均与工作区一致。
全量回归后另有 7 个运行代码文件变化，清单见[后续改动](../../.local/security-audit/fixes/post-full-suite-changes.json)。

| 验证范围 | 结果 | 本地证据 |
| --- | --- | --- |
| 全量离线回归 | 343 个文件、3276 项通过；不包含末尾改动 | [全量日志](../../.local/security-audit/fixes/full-frozen.log) |
| 末尾改动的专项回归 | 154 项展示与业务回归、114 项状态与持久化回归通过；两组有重叠 | [展示回归](../../.local/security-audit/fixes/final-presentation-regression.log)、[状态回归](../../.local/security-audit/fixes/action-status-regression.log) |
| 真实模型业务验收 | 29 个具名场景逐项复测通过 | [场景汇总](../../.local/security-audit/fixes/classified-live-results.json) |
| 最终构建的关键场景 | 姓名转账、手机号转账和“B”选择场景通过 | [最终复测](../../.local/security-audit/fixes/live-final-check/isolated-live-results.json) |
| 对抗输入 | 10 组均未造成未授权业务数据变更 | [对抗结果](../../.local/security-audit/fixes/adversarial-results.json) |
| 同机双服务器 HTTP 竞争 | 8 笔消费恰好 1 笔入账；16 次重试均返回原回执；提交后重启不重复扣款 | [HTTP 结果](../../.local/security-audit/fixes/http-race-results.json) |
| SDK 跨进程竞争 | 3 组各 8 个进程，覆盖回执重放、余额不足和分类限额 | [竞争结果](../../.local/security-audit/fixes/race-results.json) |
| 访问域名边界 | 恶意 Host 写入、读取页面、API 和静态资源均返回 403 | [Host 结果](../../.local/security-audit/fixes/host-results.json) |
| 类型、构建与依赖 | 类型检查、生产构建和修改文件的 ESLint 通过；当次依赖审计为 0 | [类型检查](../../.local/security-audit/fixes/typecheck-final.log)、[构建](../../.local/security-audit/fixes/build-acceptance-final.log)、[ESLint](../../.local/security-audit/fixes/lint-last.log)、[依赖审计](../../.local/security-audit/fixes/dependency-audit-final.json) |

29 个场景是逐项修复后的最新记录汇总。
这些记录不是同一最终构建的一次全套运行。
最终构建另跑上述 3 个关键场景。
取消后按掩码号与完整手机号重发，在 4 套全新数据库中通过。
每次都创建真实待确认操作，取消后余额与流水均不变。

另有 1 组[故障注入验证](../../.local/security-audit/fixes/forced-declaration-live-results.json)。
首条错误提交表述由脚本生成，后续 4 次请求调用真实模型。
其中恰好 1 次要求 `describe_turn`，最终只生成 1 条待确认转账。
余额和流水保持不变；该测试属于混合故障注入证据。

原始日志保留各轮失败与修复后的结果。
`live-status-1` 使用旧验收构建，不计入最新修复的验证。
本组未复现绕过确认、验证码或重复扣款。
范围不包括真实银行、真实微信投递、多主机部署和持续负载。

上述原始证据保存在本地 `.local/security-audit/fixes/`，默认不随仓库分发。
缺少原始文件时，该表只说明当时执行范围，不能作为可复验的认证。
重新执行的方法见[测试指南](../../docs/cn/test-cases.md#安全修复回归)。

## 较早分组验收

下列内容保留各组原始记录，只适用于各自标注的产品树。
这些记录使用真实在线模型、Chrome、`next dev` 和隔离数据库。
各组没有以 SDK 或 HTTP 调用代替前端操作。
下文的 HEAD 差异与未验证项按原记录范围理解。

## What each evidence set certifies

Card consumption's business month is resolved at the same instant the monthly limit was enforced with
(`banking-sdk/card.ts`, `banking-sdk/card-family.ts`; `getCards` no longer leaks `Array#map`'s index as that
instant). Production resolves that instant as `demoNow()`, so the observable behaviour must be unchanged.
The `lD`/`lE` runs are the proof that it is unchanged at `7a7a4d3`'s product tree.

`replace_card` is an agent capability for a `LOST` card of any type: the security gateway parks it as a real
`PendingAction` with `riskLevel=RED` / `requiresMfa=true` **before any card row exists**, and it executes only
after a real MFA submission. `manual_add_card` / `manual_delete_card` stay manual-only, and that restriction covers
creating a brand-new physical card and deleting a card record — not replacing a card that is already `LOST`.
The `lF`/`lG` runs are the proof at `d1cccd00`'s product tree. They do not extend to the current HEAD — the
non-document delta between the two trees is enumerated below.

| Evidence set | Certifies commit | Product tree | Verdict | Exit code |
| --- | --- | --- | --- | --- |
| `lF` round 1 (`REPORT-lF-head15de129f-round1.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lF` round 2 (`REPORT-lF-head89d82441-round2.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lF` round 3 (`REPORT-lF-headdedee51d-round3.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 3 (`REPORT-lG-headacebc393-round3.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 4 (`REPORT-lG-head6a20dd93-round4.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 7 (`REPORT-lG-headd1cccd00-round7.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lG` round 8 (`REPORT-lG-headd1cccd00-round8.md`) | `573fe009` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lC` round 4 (`REPORT-lC-heade78796d5-round4.md`) | `4b03eec8` | ≡ `d1cccd00` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lD` round 3 (`REPORT-lD-head7a7a4d3-round3.md`) | `0c50e2f` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lE` round 3 (`REPORT-lE-head7a7a4d3-round3.md`) | `0c50e2f` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lD` round 2 (`REPORT-lD-head7a7a4d3-round2.md`) | `fa36508` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `lE` round 2 (`REPORT-lE-head7a7a4d3-round2.md`) | `339c50b` | ≡ `7a7a4d3` (empty product diff) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (both signals) |
| `date-tamper-boundary.e2e.ts` (`output/playwright/REPORT-date-tamper-boundary.md`) | `fa36508` | ≡ `7a7a4d3` | **PASS 8 / FAIL 0 / SKIP 1** | `0` |
| Mock suite `acceptance.e2e.ts` (`output/playwright/REPORT-mock-suite.md`) | `fa36508` | ≡ `7a7a4d3` | **PASS 23 / FAIL 0 / SKIP 0** | `0` |
| `lB` round 1 (`live/lB-head3ba488a-round1-merged/`) | `3ba488a` | ≡ `3ba488a` (3 files differ from HEAD: `agent/tools/card.ts`, `lib/tool-feedback.ts`, one test file) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |
| `lB` round 2 (`live/lB-headd26b263-round2-final/`) | `d26b2636` | ≡ `d26b2636` (2 files differ from HEAD: `agent/tools/card.ts`, one test file) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |
| `lH` round 1 (`live/lH-head3ba488a-round1-merged/`) | `3ba488a` | ≡ `3ba488a` (same 3-file delta to HEAD) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |
| `lH` round 2 (`live/lH-headd26b263-round2-mfa-copy-fix/`) | `d26b2636` | ≡ `d26b2636` (same 2-file delta to HEAD) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |
| `lI` round 1 (`live/lI-head3ba488a-round1-merged/`) | `3ba488a` | ≡ `3ba488a` (same 3-file delta to HEAD) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |
| `lI` round 2 (`live/lI-headd26b263-round2-final/`) | `d26b2636` | ≡ `d26b2636` (same 2-file delta to HEAD) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |
| `lJ` round 1 (`live/lJ-head3ba488a-round1-merged/`) | `3ba488a` | ≡ `3ba488a` (same 3-file delta to HEAD) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |
| `lJ` round 2 (`live/lJ-headd26b263-round2-final/`) | `d26b2636` | ≡ `d26b2636` (same 2-file delta to HEAD) | **PASS 1 / FAIL 0 / SKIP 0** | `0` (`EXITCODE=0`; tool-reported code not archived with the set) |

The seven `lF`/`lG` rows and the `lC` round-4 row certify `d1cccd00`'s product tree:
`git --no-pager diff --stat d1cccd00 <round head> -- ':(exclude)*.md' banking-sdk agent security planner lib app components prisma scripts`
→ empty output for every round head (`15de129f`, `89d82441`, `dedee51d`, `a65fd5e2`, `1c674005`,
`acebc393`, `6a20dd93`, `3c5fe83e`, `d1cccd00`, `e78796d5`). One product tree therefore carries all eight certified rounds,
regardless of which evidence-only commit was HEAD when each ran. Evidence commits: `573fe009` for the `lF`/`lG` reports and `4b03eec8` for `lC` round 4. `lC` round 4 re-runs normal virtual-card consumption on this tree, so the retained `replace_card` fix is shown not to regress the plain consume path.

Equivalence is measured at the repository root with the `:(exclude)*.md` pathspec because `CONTEXT.md` lives under
those very paths: without the exclusion the command is non-empty after any documentation-only merge (for `88d38550`
→ `cab32956` it lists 22 files, all `*/CONTEXT.md`), so it cannot prove equivalence. The single `*` covers a repository-root `.md` as well as one any number of levels deep, whereas `**/*.md` matches only paths that carry at least one directory and so leaves the root `CONTEXT.md` in the list (`88d38550` → HEAD: 24 files with it, 23 without; `d26b2636` → HEAD: 86 with it, 85 without). Those leak counts come from a whole-tree diff without the product path list; with `banking-sdk … scripts` appended the two forms print identical output, because no root-level `.md` lives under those paths — the form only tightens the exclusion's coverage and changes no recorded equivalence result.

Those eight rounds do **not** extend to the current HEAD. Measured now at the repository root,
`git --no-pager diff --stat d1cccd00 HEAD -- ':(exclude)*.md' banking-sdk agent security planner lib app components prisma scripts`
→ **143 files changed, 11240 insertions(+), 1703 deletions(-)**. `d1cccd00` predates the net-value/share investment
model entirely (`banking-sdk/net-value.ts` is absent from its tree). Headline paths of that delta:
`banking-sdk/net-value.ts`, `banking-sdk/investment.ts` (+971 lines), `security/card-resolution.ts`,
`security/recipient-resolution.ts`, `lib/phone.ts`, `lib/mask.ts`, `lib/internal-text.ts`, `lib/public-text.ts`,
`lib/tool-feedback.ts`, `components/banking/HoldingFacts.tsx`, `components/banking/card-account-display.ts`,
`agent/system-prompt.ts`, `agent/tools/card.ts`, `agent/tools/decimal-schema.ts`, `agent/action-status.ts`,
`agent/workflows/parked-actions.ts`, `planner/failure.ts`, `app/security/UnlockPanel.tsx`, `prisma/schema.prisma`,
`prisma/seed.ts`, `scripts/number-backfill.ts`, `scripts/card-account-binding.ts`,
`scripts/investment-share-backfill.mjs`. These rows therefore certify `d1cccd00` and nothing later; only a re-run on the
current tree would extend them.

The remaining rows certify `7a7a4d3`'s product tree:
`git --no-pager diff --stat 7a7a4d3 <each evidence commit> -- ':(exclude)*.md' banking-sdk agent security planner lib app components prisma scripts`
→ empty for `0c50e2f`, `fa36508` and `339c50b`. Product paths have changed between `7a7a4d3` and the current HEAD:
`git --no-pager diff --stat 7a7a4d3 HEAD -- ':(exclude)*.md' banking-sdk agent security planner lib app components prisma scripts`
→ **145 files changed, 11262 insertions(+), 1708 deletions(-)** — the `d1cccd00` set plus
`agent/messages/conversation.zh-CN.json` and `agent/providers/mock/conversation-guidance.ts` — so those rows do not
extend to the current HEAD; only a re-run on this tree would.

`lD` round 1 and `lE` round 1 are kept as separate rounds in this same product tree.
Their printed summary line was `PASS 1 / FAIL 0 / SKIP 0` each, but their `EXIT=` line was produced by the
`%ERRORLEVEL%` method below, which is proven not to carry a child's exit code — so round 1 does **not** certify
an exit code. Rounds 2 and 3 re-ran the identical assertions, each in its own fresh process against a
re-provisioned database and a proven capture; those are the rounds whose exit codes count.
Nothing was deleted or weakened to reach a green round.

**Certified rounds per flow at this product tree** — `lD`: 3 executed, 2 exit-certified (rounds 2 and 3);
`lE`: 3 executed, 2 exit-certified (rounds 2 and 3). Each round is an independent process, browser and
re-provisioned SQLite file, so the three rounds are independent of one another rather than replays.

`lF`: 3 executed, 3 exit-certified (rounds 1, 2 and 3, each `0` on both signals).
`lG`: 8 executed, 4 exit-certified (rounds 3, 4, 7 and 8, each `0` on both signals).
`lC`: 4 executed, 1 exit-certified on this product tree (round 4, `0` on both signals); its earlier rounds predate the current tree.
`lG` rounds 1, 2, 5 and 6 carry no certification: rounds 1 and 2 lost their stdout before it was captured
(neither exit code, summary line nor DB number is preserved, and round 2 has no screenshots), and rounds 5 and 6
ended in the harness rather than in a product or model assertion. No assertion was weakened, skipped or deleted to
reach a green round. Full per-round table, FAIL causes and the turn-by-turn replay:
`output/playwright/live/REPORT-lF-lG-acceptance-summary.md`.

### The `lB`/`lH`/`lI`/`lJ` rows

The eight `lB`/`lH`/`lI`/`lJ` rows certify two product trees, one per round label; each row's own directory under
`output/playwright/live/` is the complete evidence set (`*.png` + `*-evidence.json` + `*-run-log.txt`).
Equivalence measured now at the repository root with
`git --no-pager diff --stat <commit> HEAD -- ':(exclude)*.md' banking-sdk agent security planner lib app components prisma scripts`
(the exclusion matters: `CONTEXT.md` files live under those paths):

- `3ba488a` → HEAD: 3 files — `agent/tools/card.ts` (2 lines), `lib/tool-feedback.ts` (7 lines),
  `agent/tools/consume-virtual-card.test.ts` (test only).
- `3ba488a` → `d26b2636`: `lib/tool-feedback.ts` alone — `publicToolError`'s MFA branch accepts both
  `验证码错误。还可尝试 N 次。` and the legacy `验证码错误，请重试。剩余尝试次数：N。` wording. Round 1 and round 2
  therefore differ on one presentation mapping, which is exactly what `lH` measures through its dock badge.
- `d26b2636` → HEAD: 2 files — `agent/tools/card.ts` (2 lines, the `rejectClientSuppliedTime` message string now
  naming the `cardType`/`cardTail`/`cardNumber` selectors) and `agent/tools/consume-virtual-card.test.ts` (test only).
  No code path these four scenarios drive changed after `d26b2636`.

Each round is an independent process against a freshly reprovisioned `prisma/live-acceptance.db`, a real headless
Chrome and the live model, so the two rounds of a flow are independent of one another rather than replays.
Every one of the eight archived run logs ends with `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` and `EXITCODE=0`;
that `EXITCODE=` line is the only exit signal archived inside those directories — unlike the `lF`/`lG` report files,
these sets carry no second, tool-reported code, so a printed `PASS` here is backed by one signal only.
The run logs also embed the original worktree paths
(`D:\projects\banking-agent\.genesis\workers\worker_T7_A701\…`) of the screenshots and evidence JSON they produced;
the archived copies are the files in each `live/<set>/` directory listed in the evidence map.

## How "live" is proven

- `.env.local` supplies `LLM_MODE=live` / `LLM_PROVIDER=deepseek` / `LLM_MODEL=deepseek-flash` /
  `DEEPSEEK_API_KEY` (gitignored; presence-only — the value is never printed, echoed or committed).
- `/api/health` → `{"ok":true,"data":{"status":"ok","time":…,"llmMode":"live"}}` on the booted app, every run.
- Resolved model id read from persisted `AgentRunEvent(eventType='provider_request_payload').payloadJson.payload.model`
  → `deepseek-flash`; `LIVE_FORCE_MODEL` unset, so `.env.local`'s id is used unchanged.
- The provider call itself is recorded by the server, never by anything the model says: `startModelRequest`
  (`lib/db/repositories/agentRun.ts:321`) commits one `ModelRequest` row — run id, ordinal, request digest, input JSON —
  under `assertAgentRunLease` **before** the provider is called, `completeModelRequest` (`:340`) moves that same row from
  `started` to `completed`/`failed` while re-asserting the lease, and `agent/providers/model-audit.ts#withModelAudit`
  persists the wire evidence as `AgentRunEvent`s — `provider_request_payload` (`:21`), `provider_response_headers`
  (`:27`) and `provider_response_event` (`:31`, through `agent/durable/journal.ts#recordModelProviderEvent`), each bound
  to the prepared `ModelRequest` (`journal.ts:130-133` rejects provider evidence when no model request was prepared).
  Model prose cannot produce any of these rows; what separates harness-only runs from a live round is that the mock mode
  reaches the same code with an in-process `banking-demo-mock` faux provider (`agent/providers/provider-mock.ts:25`), so
  these records certify a *remote* call only when read together with `llmMode: 'live'` and the `deepseek-flash` id above.
- Every business write carries a gateway `PendingAction` (RED, `requiresMfa=true`) and an `MfaChallenge` row;
  the code `123456` was typed into the real MFA card in the real browser.
- `prisma/live-acceptance.db` is reprovisioned per run (`db push` → probe → `tsx prisma/seed.ts`).
  Never `dev.db` / `test.db`, never a user backup, never a `.env.local` edit.

## Exit-code measurement (harness invariant)

Two independent signals are required per run, and a printed `PASS` with a non-zero exit code is a FAILURE.

- Signal 1 — the tool-reported process exit code, obtained with `; exit $LASTEXITCODE` after the native command.
- Signal 2 — an `EXIT=` line appended to the log with delayed expansion (`cmd /v:on`, `!ERRORLEVEL!`) and the code
  propagated with `exit !EC!`.

The `cmd /c "…"` + separate `cmd /c "echo EXIT=%ERRORLEVEL%"` form is invalid: `%ERRORLEVEL%` expands at parse
time, so it reports the value from before the program ran. Every round-2 and round-3 report carries control
experiments proving the adopted method reports `7` for `process.exit(7)` (and `0` for `process.exit(0)`), and that
the discarded method reports `0` for the same `exit 7` program.

## `lD` — virtual card apply + monthly-limit enforcement

Command per round (separate process, scenario selection only through `LIVE_SCENARIOS`):

```powershell
$env:LIVE_SCENARIOS='lD'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lD-head-round2.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lD-head-round2.log & exit !EC!"; exit $LASTEXITCODE
```

Round 2: `EXIT=0`, tool exit code `0`, `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`.
Port `51027`, dev-server pid `30688`, Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`.

**Prompt actually sent** (turn 1; no nudge or continuation consumed):

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

The consume and over-limit legs are pure `/cards` dialog submissions — **0 model turns**.

**Model behaviour**: `describe_turn {"purpose":"operation","operations":["apply_virtual_card"]}` →
`apply_virtual_card {"monthlyLimit":"100.00"}`, invocation `completed`, `attempt=1`.

**Panel reality**: one real panel — `PendingAction` `toolName=apply_virtual_card`, `riskLevel=RED`,
`requiresMfa=true`, `status=executed`; `MfaChallenge` code `123456`, `attempts=0/3`, `verified`.
No clarification, no nudge, no timeout, and `assertNoFabricatedConfirmationPanel` never fired.

**Raw `Card` row**: `type=VIRTUAL`, `status=ACTIVE`, `network=UnionPay`, `monthlyLimitMinor=10000`,
`linkedAccountId=acct_checking`, `creditLimitMinor=null`, `availableLimitMinor=null`.
Card id `cardidem_c9d4e2a18b5823d8e71913e140f25b13`, mask `****1418`.
`/cards` renders 账户可用余额 / 当前可支付金额 only — no 信用额度 / 可用额度 anywhere.

**Money movement** (round 1 → round 2):

| Item | Round 1 | Round 2 |
| --- | --- | --- |
| Checking balance minor | `2358000` → `2355000` | `2358000` → `2355000` |
| New `channel=CARD` / `direction=DEBIT` `Transaction` | `cmvc08e0h005djsf8lhgjfku3` (−`3000`) | `cmvc12d8j004114f8o26zpzup` (−`3000`, merchant `虚拟卡开卡消费验证`) |
| New `CardConsumption` | `cmvc08e0i005ejsf879h6985o` (`3000`) | `cmvc12d8k004214f8864larvi` (`3000`) |
| Server-projected payable | `100.00` → `70.00` | `100.00` → `70.00` |
| Over-limit `80.00` | `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。` / screen `超出本月消费限额`, payable stays `70.00`, zero funds/ledger/consumption movement | same; merchant rows in `Transaction` and `CardConsumption` = `0` |

`Transaction.occurredAt` = `CardConsumption.occurredAt` = `2026-09-25T04:00:00.000Z` (`demoNow()`).
The `apply_virtual_card` receipt's `resultJson.card.payableAmount` is `"70.00"` — the enforced month's remainder,
i.e. the snapshot resolves the month at the enforced instant.
Payable is the server projection `min(account available cash, remaining monthly allowance)`, not a model-invented number.

### `lD` round 3 (`0c50e2f`, product tree ≡ `7a7a4d3`)

Fresh process, fresh `prisma/live-acceptance.db`, same real browser:

```powershell
$env:LIVE_SCENARIOS='lD'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lD-head-round3.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lD-head-round3.log & exit !EC!"; exit $LASTEXITCODE
```

Both signals: tool-reported process exit code `0`, log line `EXIT=0`.
Summary `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`, wall clock `38.55 s`, port `55343`, dev-server pid `58284`.

**Prompt actually sent** (turn 1; zero nudges, zero continuations): `请帮我新开一张虚拟卡，月消费限额设为100元`.
The consume and over-limit legs are pure `/cards` dialog submissions — 0 model turns.

**Raw `Card` row**: `cardidem_974723860f5e22adc06772726460e218`, `type=VIRTUAL`, `status=ACTIVE`,
`network=UnionPay`, `numberMasked=****2003`, `monthlyLimitMinor=10000`, `linkedAccountId=acct_checking`,
`creditLimitMinor=null`, `availableLimitMinor=null`, `replacedByCardId=null`.

**Money movement**: checking balance `2358000` → `2355000`;
`channel=CARD` / `direction=DEBIT` `Transaction` `cmvc1o8o200418sf8ixspw918` (−`3000`, merchant `虚拟卡开卡消费验证`) +
`CardConsumption` `cmvc1o8o300428sf8cdofet99` (`3000`). Rendered tile rows:
after apply `{"账户可用余额":"¥23,580.00","当前可支付金额":"¥100.00"}`, after spend
`{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}`; dialog summary
`{"关联账户":"****8821","账户可用余额":"¥23,580.00","月限额":"¥100.00","当前可支付金额":"¥100.00"}`.
Over-limit `80.00` → HTTP `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。`, on-screen `超出本月消费限额`,
payable stays `70.00`, zero balance / `Transaction` / `CardConsumption` movement.

**Gate-row caveat for this round**: the isolated DB is reprovisioned by the next run, and `lE` round 3 ran
afterwards against the same file, so `lD`'s own `PendingAction` / `MfaChallenge` / `ToolInvocation` rows are no
longer dumpable. Nothing was invented to fill the gap: this round's panel facts rest on the scenario's enforced
assertions plus its PASS evidence line (`MFA 123456 → 新虚拟卡 …`), with `lE`'s dumped rows as corroboration only.
Rounds 1–2 own their dumped gate rows.

**Screenshots** (`output/playwright/live/lD-head7a7a4d3-round3/`): `01-lD-new-virtual-card.png`,
`02-lD-after-spend.png`, `03-lD-over-limit-refusal.png`.

## `lE` — 挂失 → 补办 → consume on the new card

Command per round: `$env:LIVE_SCENARIOS='lE'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`.
Round 2: `EXIT=0`, tool exit code `0`, `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`.
Port `52744`, dev-server pid `14572`.

**Prompts actually sent** (each leg resolved on turn 1; no nudge needed):

```
开卡 : 请帮我新开一张虚拟卡，月消费限额设为100元
挂失 : 我刚才新办的那张虚拟卡（尾号4977，月限额100元）丢失了，请帮我正式挂失这张卡
补办 : 请为我刚才挂失的虚拟卡（原卡尾号4977）补办一张新卡
```

The tail `4977` is the mask the harness had just created — no invented data.
Round 1 used its own real tail (`5706`).

**Tool calls** (all `completed`, `origin=pi`, `operationKey` == the matching `PendingAction.id`):
`apply_virtual_card {"monthlyLimit":"100.00"}` → `report_lost_card {"cardId":"<source>","reason":"用户报告卡片遗失，要求正式挂失"}`
→ `replace_card {"cardId":"<source>"}`.

**Panel reality**: three `PendingAction` rows (`riskLevel=RED`, `requiresMfa=true`, `status=executed`) each with one
`MfaChallenge` (`123456`, `attempts=0/3`, `verified`). No wrong code, no lock, no re-prompt, no fabricated-panel claim.

**Raw `Card` cross-check**:

- Source `cardidem_b0aeb5ece9b12e0edec896d1323b239f` (`****4977`) stays terminal `LOST` with
  `replacedByCardId=cmvc1boyz00emvof8fi5avmcs`; the 挂失 leg moved **zero** funds.
- **Exactly one** new `VIRTUAL` / `ACTIVE` card (`****0148`, ≠ `****4977`) with
  **`linkedAccountId=acct_checking` inherited** from the source, `monthlyLimitMinor=10000`,
  `creditLimitMinor` / `availableLimitMinor` null.
- **Monthly allowance continues, never resets**: `100.00` (apply) → `70.00` (after the `30.00` pre-lost spend) →
  **`70.00` after 补办** (rendered `当前可支付金额 = ¥70.00`, the `100.00` reset explicitly excluded) → `0.00`
  (after the `70.00` spend) → `0.00` (after a refused `1.00`).
- Pre-lost spend on the source: `Transaction` `cmvc1bi5w0041vof86pezrbir` (−`3000`) +
  `CardConsumption` `cmvc1bi5x0042vof8t9lxd5yz` (`3000`), balance `2358000` → `2355000`.
- Spend on the replacement, exactly once: `channel=CARD` / `direction=DEBIT` `Transaction`
  `cmvc1bq4f00f2vof8dqr5jryd` (−`7000`) + `CardConsumption` `cmvc1bq4g00f3vof8fkqbg3jx` (`7000`),
  balance `2355000` → `2348000`.
- Refused `1.00` after exhaustion (`虚拟卡超限拒绝验证`): `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。`,
  screen `超出本月消费限额`, zero `Transaction`, zero `CardConsumption`, balance unchanged, payable `0.00`.
- Available credit does not double: the only non-`LOST` `CREDIT` row is `card_credit` (`1800000` minor = ¥18,000.00);
  the `LOST` source contributes nothing and no virtual card carries credit fields.

Round 1 numbers are the same shape (`REPORT-lE-head7a7a4d3-round1.md`): source `****5706` → `LOST`,
replacement `****8108`, continuity `100.00` → `70.00` → `70.00` → `0.00`, balance `2358000` → `2355000` → `2348000`,
three panels all backed by real rows.

Both consumption rows carry `occurredAt=2026-09-25T04:00:00.000Z`; no request body sent an `occurredAt`.

### `lE` round 3 (`0c50e2f`, product tree ≡ `7a7a4d3`)

Separate process after `lD` round 3 (shared test DB must never overlap), same proven capture:

```powershell
$env:LIVE_SCENARIOS='lE'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lE-head-round3.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lE-head-round3.log & exit !EC!"; exit $LASTEXITCODE
```

Both signals: tool-reported process exit code `0`, `EXIT=0`; summary `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`,
`49.08 s`, port `64156`, dev-server pid `43036`.

**Prompts actually sent** (each leg resolved on turn 1, no nudge):

```
开卡 : 请帮我新开一张虚拟卡，月消费限额设为100元
挂失 : 我刚才新办的那张虚拟卡（尾号4348，月限额100元）丢失了，请帮我正式挂失这张卡
补办 : 请为我刚才挂失的虚拟卡（原卡尾号4348）补办一张新卡
```

Tail `4348` is the mask the harness had just created — no invented data.

**Tool calls** (all `completed`, `attempt=1`, `origin=pi`): `describe_turn apply_virtual_card` →
`apply_virtual_card {"monthlyLimit":"100"}` → `describe_turn report_lost_card` → `get_cards {}` →
`report_lost_card {"cardId":"<source>","reason":"用户表示虚拟卡（尾号4348）丢失，申请正式挂失"}` →
`describe_turn replace_card` → `replace_card {"cardId":"<source>"}`.

**Panel reality** (read from the git-ignored local dump `logs/live-round3-db.json`, which is not repository
evidence): three `PendingAction` rows, `riskLevel=RED`, `requiresMfa=true`,
`status=executed`, `argsJson` normalized (`apply_virtual_card` → `{"monthlyLimit":"100.00"}`); three `MfaChallenge`
rows, code `123456`, `attempts=0/3`, `status=verified` (`verifiedAt` `06:58:22.594Z`, `06:58:35.682Z`,
`06:58:38.851Z`).

**Raw `Card` cross-check**:

- Source `cardidem_a0bf16b0dc3c770b43a656c69da38384` (`****4348`) → `LOST`,
  `replacedByCardId=cmvc1pci500gl6kf8xwue5yfy`.
- Replacement `cmvc1pci500gl6kf8xwue5yfy` (`****5448`) `VIRTUAL` / `ACTIVE`, `monthlyLimitMinor=10000`,
  **`linkedAccountId=acct_checking` inherited** from the source, credit fields null.
- Allowance continuity: `100.00` → `70.00` → **`70.00` after 补办** → `0.00` → `0.00` (refused `1.00`).
- Pre-lost `30.00` spend: `Transaction` `cmvc1p2jh00456kf8rhwxniug` (−`3000`) + `CardConsumption`
  `cmvc1p2ji00466kf8u4ze9cfs` (`3000`, `cardId`=source), balance `2358000` → `2355000`.
- Post-补办 `70.00` spend on the new card, exactly once: `Transaction` `cmvc1pdn700h16kf8yu8422d2` (−`7000`) +
  `CardConsumption` `cmvc1pdn800h26kf8biovrmpp` (`7000`, `cardId`=replacement), balance `2355000` → `2348000`.
- Exactly **2** `CardConsumption` rows in total, distinct `executionKey`s (`63f9e331-…`, `747632fd-…`), both
  `occurredAt=2026-09-25T04:00:00.000Z`; no request body carried `occurredAt`.
- Refused `1.00` after exhaustion → `422 LIMIT_EXCEEDED` `超过虚拟卡月限额。`, zero
  `Transaction` / `CardConsumption`, balance unchanged.
- Available credit not doubled: the only non-`LOST` `CREDIT` row is `card_credit` (`1800000` = ¥18,000.00).

**Screenshots** (`output/playwright/live/lE-head7a7a4d3-round3/`): `01-lE-replacement-card.png`,
`02-lE-exhausted-refusal.png`.

## `lF` — credit 挂失 → 补办 in a new session

Scenario id `lF` (`lF-live-credit-report-lost-and-replace-new-session`), selected with `$env:LIVE_SCENARIOS='lF'`.
Two model legs, each resolving on its first turn — no nudge and no continuation budget spent:

```
挂失 : 我的尾号6688信用卡丢失了，请正式挂失，我确认不可撤销。
补办 : 请为刚挂失的尾号6688信用卡补办新卡。
```

Both legs are RED: `report_lost_card {"cardId":"card_credit",…}` and `replace_card {"cardId":"card_credit"}` each
persist a `PendingAction` (`riskLevel=RED`, `requiresMfa=true`) plus one `MfaChallenge` (`123456`, `attempts=0/3`,
`verified`). While `replace_card` waits, `GET /api/cards` still reports `cardCount=3`, `sourceStatus=LOST`,
`sourceReplacedByCardId=null`, `newlyCreatedCardIds=[]` — the park creates no card and changes no status; only the
MFA submission produces the replacement.

**Round 3 raw rows** (`REPORT-lF-headdedee51d-round3.md`): source `card_credit` stays `CREDIT`/`LOST`,
`numberMasked=****6688`, `replacedByCardId=cmve0pkb700b2ugf8qcnl4km9`; the replacement
`cmve0pkb700b2ugf8qcnl4km9` is `CREDIT`/`ACTIVE`, `numberMasked=****4485` (a new number),
`creditLimitMinor`/`availableLimitMinor` = `1800000`/`1800000` inherited unchanged; card count `3 → 4`.
Rounds 1 and 2 show the same shape with `****3613` (`cmve04n3r00b2v0f89am4wwf4`) and `****7720`
(`cmve0n2z1009ufof84bgdlc5k`).

**Available credit is counted once**: the non-`LOST` `CREDIT` available total is `18000.00` before and after the
replacement; the naive total over all `CREDIT` rows including the `LOST` source is `36000.00` and is explicitly
excluded as the bug signature. `/cards` renders it per tile — the replacement tile shows `信用额度 ¥18,000.00` /
`可用额度 ¥18,000.00`, while the `LOST` source tile still renders `可用额度 ¥18,000.00` and is not summed.

**No money moves**: dashboard `23580.00` → `23580.00`, `GET /api/bills` added `0` / removed `0`, `Transaction`
rows `232` before and after, `CardConsumption` rows `0`.

**Model identity** comes from persisted rows, not only from health:
`AgentRunEvent(eventType='provider_request_payload')` → `payloadJson.payload.model` = `deepseek-flash` for every
payload row (round 3: 6 rows, `unparsablePayloads=0`, `payloadsWithoutPayloadModel=0`; round 2: 5 rows).
Round 1's extractor printed `model counts=[]` and carries no row evidence, so round 1's model identity rests on
`/api/health` `llmMode:"live"` plus the harness header.

## `lG` — full card-loss → replace chain in one session

Scenario id `lG` (`lG-live-full-card-loss-replace-chain-single-session`), selected with `$env:LIVE_SCENARIOS='lG'`.
One chat session drives six verbatim prompts (`MAX_TURNS_PER_LEG=6` natural turns per write leg), with the two
front-end `/cards` consume legs interleaved at **0** model turns:

```
1 请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。
2 尾号<mask>的虚拟卡信息泄露，请正式挂失，我确认不可撤销。
3 请为刚才正式挂失的尾号<mask>虚拟卡再补办一张新卡。
4 尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。
5 请为刚挂失的尾号6688信用卡补办新卡。
6 确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。
```

`<mask>` is the last four digits of the card prompt 1 actually created (round 7 `****1865`, round 8 `****3433`),
derived at runtime — never an invented number.

**Turn 5 is the capability proof**: it produces a real `replace_card {"cardId":"card_credit"}` and a RED MFA panel,
and no assistant turn in rounds 3–8 answers it with `「补办实体信用卡和借记卡只能在「卡片」页面手动办理」`.
**Turn 6 is accepted in two shapes and never grows the card count**: round 7 answered prose-only (`describe_turn` +
`get_cards`, `finalTurn.action === undefined`, `6 → 6`); round 8 re-emitted `replace_card`, parked a second
`PendingAction`, rendered a real panel, and replayed the existing replacement instead of issuing a second card —
the same `commandDigest 14fc01beedc9156bb968b4e743dc79231f75ee172248e4fa3b7429bd8338cb6d`, the same replacement
card `cmve4oa9d00rc50f8njjc711f`, `cardCountBefore=6` / `cardCountAfter=6`, `mfaCompleted=true`.

**Virtual leg** (rounds 7/8 shape): the new `VIRTUAL`/`ACTIVE` card inherits `linkedAccountId=acct_checking` and
`monthlyLimitMinor=10000`, with `creditLimitMinor`/`availableLimitMinor` null. Source and replacement share one
monthly allowance, so it never resets on 补办: payable `100.00` → `70.00` (after the `30.00` spend) → **`70.00`
after the replacement** → `0.00` (after the `70.00` spend), and the following `1.00` is refused
`422 LIMIT_EXCEEDED` `超过虚拟卡月限额。` with zero financial movement.

**Credit leg**: source `card_credit` stays `CREDIT`/`LOST` with `replacedByCardId` pointing at the single new
`CREDIT`/`ACTIVE` card (`****8718` / `cmve4i4c300o6b4f8cqjdvnrp` in round 7; `****0495` /
`cmve4oa9d00rc50f8njjc711f` in round 8), which inherits `1800000`/`1800000`. The non-`LOST` `CREDIT` available
total stays `18000.00`; the naive all-`CREDIT` `36000.00` is excluded as the bug signature.

**Money moves only through consumptions**: `acct_checking.balanceMinor` `2358000` → `2355000` → `2348000`;
exactly two new `channel=CARD` / `direction=DEBIT` `Transaction` rows (−`3000` 虚拟卡开卡消费验证, −`7000`
虚拟卡补办续限验证) and exactly two `CardConsumption` rows — `3000` attributed to the **source** card and `7000`
to the replacement, so historical attribution is never re-pointed. `GET /api/bills` added `2` / removed `0`.
No request body carried `occurredAt`; both rows are server-stamped `2026-09-25T04:00:00.000Z` (`demoNow()`).
A 补办 itself moves no money.

Card counts are derived from the scenario's own start-of-run `GET /api/cards` baseline, never a hardcoded total:
`3 → 4` (virtual source) `→ 4` (`LOST`) `→ 5` (virtual replacement) `→ 5` (credit `LOST`) `→ 6` (credit
replacement) `→ 6` (final turn).

## Date-tampering boundary — a separate entry from the browser flows

`tests/e2e/date-tamper-boundary.e2e.ts` sends raw HTTP to the running app against **its own isolated DB
`prisma/live-acceptance-date-tamper.db`** (≠ `e2e.db` / `test.db` / `dev.db`), with no model, no browser and no DOM.
It is deliberately a different entry from `live-acceptance.e2e.ts`: nothing in it is a frontend-interaction
assertion, and no browser scenario asserts a forged timestamp.

`pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts` → `SUMMARY cases=9 pass=8 fail=0 skip=1 → exit code 0`.

The forged-date repro, replayed end-to-end: create a VIRTUAL card with monthly limit `100.00` through the real routes
(`POST /api/cards` → `POST /api/cards/changes/[id]/verify` with `{"code":"123456"}`) → consume `10.00` normally →
`POST /api/cards/[id]/consume` with `90.00` and a **previous-month** `occurredAt` (`2026-08-01T04:00:00.000Z`) →
**`400`** `{"ok":false,"error":{"code":"VALIDATION","message":"Consumption time is server-owned: 'occurredAt' must not be sent"}}`
with **zero** movement (balance `23570.00` unchanged, consumption count `1`, month total `10.00`, `forgedAmountRows=0`)
→ consume `1.00` normally → **month booked total exactly `11.00`**.

The same refusal with the same zero side effects holds for a future date (`2026-12-24T04:00:00.000Z`),
a malformed date (`"not-a-date"`) and `occurredAt: null`.
Payable afterwards `89.00 = min(23569.00, 100.00 − 11.00)`.

Honest **SKIP**: `x1-model-seam-http` — the model-facing refusal in `agent/tools/card.ts`
(`消费入账时间由服务端决定`) is not reachable over HTTP (no route turns arbitrary tool arguments into a
`PendingAction`), so only the HTTP route contract is proven.

## Mock suite (kept green)

`pnpm exec tsx tests/e2e/acceptance.e2e.ts` → `== 汇总：PASS 23 ｜ FAIL 0 ｜ SKIP 0 ==`, exit code `0`,
`prisma/e2e.db`, real headless Chrome, `LLM_MODE=mock`.
Notable coverage: `b-transfer-mfa` wrong code → `验证失败，已尝试 1 次` with the card retained and no movement;
`j-circuit-breaker-lock` three wrong codes lock the owner across a reload; `f-wedge-refresh-recover` settles the
receipt exactly once; `h-investment-flow` `−1000.00` DEBIT / `+6178.36` CREDIT.

## The four defects: root cause, fix, data upgrade and recovery

Each row names the section that holds its live evidence; no number is restated here, every one of them is read from the
archived artifacts of that section.

| Defect | Root cause | Fix | Data upgrade and recovery | Live evidence |
| --- | --- | --- | --- | --- |
| ① Investment holdings by net value and shares | Holdings were accounted as a cost/gain snapshot, so a negative return ratio reached the non-negative ratio gate (`components/banking/HoldingFacts.tsx` → `lib/decimal.ts#rateRatioToPercent`), which throws `Financial value must be nonnegative.` and unmounts the whole client tree; the chat investment card also projected the pre-write holdings because `agent/card-emitter.ts` had no `subscribe_investment`/`redeem_investment` case | `marketValue = shares × latestNetValuePerUnit`, 4 dp net value and 6 dp shares, the non-negative gate kept for booked amounts only, signed ratios rendered through `lib/decimal.ts#signedRateToPercent`; an investment write re-reads the position post-commit; a redemption states an explicit `SHARES`/`AMOUNT`/`ALL` mode | `node scripts/db-backup.mjs` first, then `node scripts/investment-share-backfill.mjs` (dry run) and `--apply`, which derives `shares = FLOOR(market value ÷ net value, 6 dp)` for legacy holdings, flags every row it writes `shares_estimated = 1`, never fabricates a share count for a product that publishes no net value (reported as `历史数据不足`), and rewrites the stored `estimatedMarketValue` to the exact `shares × net value`; `pnpm db:push` synchronizes the schema and `pnpm db:reset` rebuilds the demo data | the `lB` section |
| ② A retryable wrong MFA code rendered as a transport failure, plus internal markers on screen | `lib/tool-feedback.ts#publicToolError` keyed on a closed set of sentences that did not accept the server's `验证码错误。还可尝试 N 次。`, so an `mfa_code_invalid`/`MFA_FAILED` result degraded to the fallback `chat.error.request` (`请求失败，请检查网络后稍后重试。`); internal sentinels (`__SECURITY_BLOCK__` payloads, JSON fragments, stack frames) could reach public text | `publicToolError` maps the typed sentence (and the legacy `验证码错误，请重试。剩余尝试次数：N。`) to `chat.error.verificationRemaining`; `lib/internal-text.ts#isInternalDiagnostic` is the single predicate and `lib/public-text.ts` the single funnel, whose `securityNotice` carries the only `?? 0` default for remaining attempts | none — presentation and containment only, no schema or data change | the `lH` section |
| ③ Complete test numbers versus number and card-tail resolution | Identity was resolved from masked or tail values while the stored columns held only a mask, so a near-miss number sharing a visible prefix could identify the wrong payee or card, and a complete number had no authoritative column | `Contact.phoneFull` / `Card.numberFull` hold the complete fictional number and are the only identity (`security/recipient-resolution.ts`, `security/card-resolution.ts`, `lib/phone.ts`, `lib/mask.ts`); masks and tails only narrow candidates; every outward projection stays masked; `cardId`/`cardTail`/`cardNumber`/`cardType` are canonicalized to one owned id | `node scripts/number-backfill.ts` fills `phoneFull` / `numberFull` only for rows where the column is still `null`, by COPYING a display column that is itself a complete value and then masking that display column through `lib/mask.ts`; it never derives a number, reports `unrecoverable-masked` for a mask, is idempotent, and its rollback clears only rows that still hold the value it wrote | the `lI` section |
| ④ A debit or virtual card did not show the balance it spends from | A DEBIT/VIRTUAL card carried no reference to the account it draws on, so `/cards` could project neither that account's cash nor the card's spendable amount | `Card.linkedAccountId` is a real foreign key to `Account.id`; `CardView.linkedAccountStatus` (`LINKED`/`MISSING`/`UNTRUSTED`/`NOT_APPLICABLE`) plus `usable` decide the projection; `accountAvailableBalance` is the settlement account's cash and `payableAmount = min(account cash, remaining monthly limit)`; `MISSING`/`UNTRUSTED` omit every balance field instead of reporting zero | `node scripts/card-account-binding.ts` binds legacy account-funded cards (`linkedAccountId IS NULL`, CREDIT cards skipped) to an owned CHECKING account and never guesses when the choice is ambiguous; `pnpm db:push` adds the foreign key | the `lJ` section |

Every step above is repeatable: each backfill scans only rows still in its un-migrated state, and `logs/db-backups/`
holds the pre-change snapshot a rollback restores (`node scripts/db-backup.mjs` reads through the WAL, so committed rows
are not lost the way a plain file copy would lose them).

## Gate results and the commits they belong to

| Gate | Result | Exit code |
| --- | --- | --- |
| `pnpm test` (whole suite) | 3126 / 3126 passing | `0` |
| `pnpm typecheck` | 0 errors | `0` |
| lint | 0 findings | `0` |
| `next build` | success | `0` |
| `acceptance.e2e.ts` (mock, 23 journeys) | `PASS 23 / FAIL 0 / SKIP 0` | `0` |
| `date-tamper-boundary.e2e.ts` | `cases=9 pass=8 fail=0 skip=1` | `0` |
| every certified live round in the table at the top | `PASS 1 / FAIL 0 / SKIP 0` | `0` |

The whole-suite, typecheck, lint and build results belong to the final-verification commit `88d38550`.
The browser entries were run on the product trees named in their own rows, not on `88d38550`; the equivalence sections
above are what connect them, and none of them is claimed beyond its own tree.
Report head: `cab32956` (merge of the report branch with the final-verification branch), which is the tip of this task's
branch `evogit-agent-T7-A1`. `88d38550` is an ancestor of that merge and the merge's only difference from it is
documentation, so the gate numbers above still describe the product tree these live rounds were measured against; the same
`git --no-pager diff --stat cab32956 HEAD -- ':(exclude)*.md' banking-sdk agent security planner lib app components prisma scripts`
command prints nothing between `cab32956` and current `HEAD` either: everything committed after that merge is documentation.
Nothing was pushed to a remote: no branch of this task was published and no remote-tracking ref was updated.
No API key is recorded here: `.env.local` is described by existence only and is never read, printed or committed, and no
run log, evidence JSON or screenshot carries a credential value.

## Real WeChat: still 待验证

`channels/weixin/` is exercised by the `tests/unit/weixin-*.test.ts` suites, `tests/integration/weixin-protocol.test.ts`
and the protocol-level `tests/e2e/weixin-live.e2e.ts`, which drives a local protocol server rather than a phone.
Sending and receiving on a real WeChat account needs the user to scan a QR code and bind the bot, so that path stays
**待验证**: no rendering, protocol or capability test stands in for it, and no round in this report proves it.

## NOT verified by these runs

- **Live scenarios with no certification at any product tree**: `lA`, `lC`, `lD`, `lE` (`lD`/`lE` certify
  `7a7a4d3`'s tree only, `lC` certifies `d1cccd00`) and live ids `0`–`15`, `2p`, `7`. `lF`/`lG` certify
  `d1cccd00`'s product tree only — the non-document delta to HEAD is 143 files, enumerated above; `lB`/`lH`/`lI`/`lJ`
  certify `3ba488a` and `d26b2636` and not the two files that differ between `d26b2636` and HEAD. Nothing here
  extends to a sibling scenario.
- **`lG` rounds 1 and 2 are not preserved**: their exit code, summary line, duration, model-id rows and DB numbers
  exist nowhere, and round 2 has no screenshots. Both reports are labelled post-hoc reconstructions and certify
  nothing.
- **`lG` rounds 5 and 6 carry no summary line and no `-evidence.json`** — the process ended inside the
  `unhandledRejection` handler, so their business legs are corroborated by the post-run DB dump only.
- **`lF`'s "dashboard API + page do not double count the old card" is asserted per non-`LOST` `CREDIT` tile** —
  `app/cards/page.tsx` renders no page-level aggregate of available credit, so a page-level assertion has nothing to
  attach to. Product gap, reported not fixed; the helper records it at
  `tests/e2e/card-replace-chain.e2e-helper.ts:194-195`.
- **`DEBIT` replacement is not exercised** by `lF`/`lG`; the "any type" claim rests on the type-neutral catalog entry
  plus the executed `CREDIT` and `VIRTUAL` legs.
- **The panel-claim negation rule is not proven by Vitest here** — its `tests/unit/panel-claim.test.ts` cases are
  backed in this evidence only by an executed standalone 64-case table run through `pnpm exec tsx`.
- **Model-facing date refusal** (`agent/tools/card.ts`, SKIP `x1`) — not reachable over HTTP; the boundary entry
  proves the route contract only.
- **MFA wrong-code / circuit-breaker paths under the live model** — every live leg submitted only the correct code
  (`attempts=0/3`); the mock suite covers the lock path, not the live model.
- **`lE` post-补办 available credit** was derived from RAW `Card` rows (sum of non-`LOST` `CREDIT` limits),
  not from a dashboard API read.
- **`lD` over-limit HTTP status** was read from the harness network log (`[4xx/5xx] POST 422 … LIMIT_EXCEEDED`)
  plus the on-screen `role="alert"` text; no independent raw-HTTP repro was made for the limit seam.
- **Model stability is still not proven** — `lD`/`lE` ran 3 independent rounds each and `lF` 3, all passing, and
  `lG`'s turn 6 came out prose-only in round 7 and as a replayed `replace_card` in round 8; a finite number of
  rounds bounds non-determinism, it does not prove it absent over unlimited runs.
- **`lD` round 3 gate rows are not dumpable** — the run's `PendingAction` / `MfaChallenge` / `ToolInvocation` rows
  were destroyed by `lE` round 3 reprovisioning the same isolated DB. Rounds 1–2 own dumped rows; round 3's panel
  evidence comes from the scenario assertions and its PASS line only.
- **No production build** (`next build`), no cluster/concurrency, no real banking rail — local single-process demo only.
- Other nodes' Vitest suites (`tests/unit`, `tests/scenarios`, `tests/app`, `tests/integration`) were not run by this node.
- **`lB`/`lH`/`lI`/`lJ` carry no per-round `REPORT-*.md`** — unlike `lD`/`lE`/`lF`/`lG`, these four flows exist only as
  `output/playwright/live/<set>/` (screenshots + `*-evidence.json` + `*-run-log.txt`). Every number in the four
  sections below is read out of those three artifact kinds.
- **Only one exit signal is archived for the eight `lB`/`lH`/`lI`/`lJ` sets**: `EXITCODE=0` inside the run log.
  The tool-reported process code was not captured into the evidence directory, so the two-signal invariant of
  `## Exit-code measurement` cannot be re-checked from the archived artifacts of these sets.
- **Earlier rounds of these four flows ran on other product trees and are outside these eight sets** — `lB` round 2 on
  `89ea7891` ended `PASS 0 ｜ FAIL 1` on a **test-side** race (`B1 之后聊天里最新投资卡的持仓份额应为 5965.395384 份
  （写后重读的 DB 值），实际 4999.864825 份`: the assertion read the pre-write chat card), `lB` round 1 on
  `7e66cee7`/`ec12289d` passed while covering only the regression leg (no B3–B5), and `lH` round 2 on `0da121d2`
  ended exit 1 as a **session-lease flake** (first `POST /api/chat` `500 INTERNAL`, then two
  `409 Another agent run owns this session`, dock never appeared, `waitForMfaCard` timed out at 90 s) with product and
  scenario code unchanged between rounds. None of the three is a product verdict, and none of them is one of the eight
  certified sets. The `lB` artifacts for those rounds are not repository evidence: `logs/` is a git-ignored, untracked
  local path holding `logs/lB-CERTIFICATION.md`, `logs/lB-r2.log`, `logs/lB-r3.dbcheck.log` and the like, which exist
  only in the workspace that produced them: reading material, not part of the certified evidence surface.
- **`lB`'s two diagnosed defects are recorded, not re-proven by these rounds**: the whole-page client crash
  `Financial value must be nonnegative.` raised from `lib/decimal.ts#nonNegativeDecimal` through
  `components/banking/HoldingFacts.tsx#rateRatioToPercent(profitRate)` for a negative `profitRate` (it blanks `/agent`,
  so `textarea[data-chat-composer="true"]` never renders), and a chat investment card that projected the pre-write
  holdings because `agent/card-emitter.ts` had no `subscribe_investment`/`redeem_investment` case. These rounds assert
  the post-write projection (`5965.395384` shares re-read after the write) on a holding whose return is positive;
  they never render a negative return ratio, so the non-negative gate is not exercised here.
- **The MFA wrong-code dock copy is proven only for the two wordings these rounds rendered** —
  `chat.error.request` (`请求失败，请检查网络后稍后重试。`) in `lH` round 1, `验证码错误。还可尝试 1 次。` in `lH` round 2.
  `cards.mfa.failedAttemptsLimit` stays unreachable: the dock unmounts in the same fold that reaches the terminal
  status, so no round can show that variant.
- **`lH` never resets the breaker** — it depends on the per-round reprovisioned `prisma/live-acceptance.db`; a second
  `lH` run on the same file starts already locked. Only the mock `j-circuit-breaker-lock` drives the developer reset
  button.
- **`lI` shows two accepted card selectors, not their equivalence**: round 1's model emitted
  `set_card_limit {"cardId":"card_credit","category":"餐饮","amount":"1000.00"}` and round 2's emitted
  `set_card_limit {"cardTail":"6688",…}`. Both park and execute; no round shows one model producing both shapes and no
  round shows the server refusing either.
- **`lI`'s masking claim covers the surfaces these rounds read** (confirm card, assistant prose, tool-result text,
  persisted session JSON). A full number that reached none of those surfaces is not thereby proven absent from
  renderings the rounds never visited.
- **`lJ` covers `usable === false` only as `/cards` tiles** — a `FROZEN` debit card and a `LOST` virtual card keep their
  real balance with a disabled consume entry. No round renders a `MISSING` or `UNTRUSTED` binding on `/cards`; those two
  states are asserted only by the server-side projection suites.
- **Rounds that aborted for environment reasons** — the disk-exhaustion failure `磁盘空间不足 (os error 112)` — left no
  artifact under `output/playwright/live/`, so nothing in this file certifies or reconstructs them. Before this note the
  text appeared in no preserved round artifact and nowhere in this document's history
  (`git --no-pager log --all --oneline -S"os error 112" -- tests/e2e/LIVE-ACCEPTANCE-REPORT.md` is empty), so this bullet
  records the fact of the abort, not a recovered round; the preserved failure rounds remain the `lG`/`lB`/`lH` ones
  enumerated above.
- **Model stability is still not proven** for these flows either: `lB`'s bare-number clarification came out as a
  two-part question in round 1 and a three-part one in round 2, and `lI`'s selector choice differed between rounds; a
  finite number of rounds bounds non-determinism, it does not prove it absent.

## Evidence map

| Path | Content |
| --- | --- |
| `output/playwright/live/REPORT-lF-lG-acceptance-summary.md` | consolidated `lF`/`lG` deliverable: all 11 rounds, FAIL causes, exact commands + exit-code calibration, turn-by-turn replay, DB verification, unresolved list, evidence map, cleanup |
| `output/playwright/live/REPORT-lF-head{15de129f,89d82441,dedee51d}-round{1,2,3}.md` | `lF` rounds 1–3: certified head, dual exit signal, verbatim prompts, `PendingAction`/`MfaChallenge` rows, card table, per-tile credit check, ledger invariance |
| `output/playwright/live/REPORT-lG-head{acebc393,6a20dd93,d1cccd00}-round{3,4,7,8}.md` | `lG` certified rounds: full six-prompt chain, tool calls, panels, virtual + credit card rows, allowance continuity, DB facts, cleanup snapshot |
| `output/playwright/live/REPORT-lG-head{a65fd5e2,1c674005}-round{1,2}.md` | `lG` rounds 1–2, post-hoc reconstructions — no stdout, no exit code, no DB numbers (round 2 has no screenshots) |
| `output/playwright/live/REPORT-lG-head{6a20dd93,3c5fe83e}-round{5,6}.md` | `lG` rounds 5–6: verbatim failure line plus `EXIT=1`; no summary line, no `-evidence.json` |
| `output/playwright/live/lF-head*-round*/*.png` | `lF`: `/cards` after 挂失, `/cards` after 补办 (2 per round) |
| `output/playwright/live/lG-head*-round{1,3,4,5,6,7,8}/*.png` | `lG`: virtual replacement, exhausted-allowance refusal, credit replacement (3 per round; round 2 has none) |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round3.md` | lD round 3: commit certified, exit-code controls, prompt, tool calls, DB numbers, screenshots, gate-row caveat |
| `output/playwright/live/REPORT-lE-head7a7a4d3-round3.md` | lE round 3: same shape, plus three panels and allowance continuity |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round2.md` | lD round 2: commit certified, exit-code controls, prompt, tool calls, gate rows, DB numbers, screenshots |
| `output/playwright/live/REPORT-lE-head7a7a4d3-round2.md` | lE round 2: same, plus three panels and allowance continuity |
| `output/playwright/live/REPORT-lD-head7a7a4d3-round1.md`, `…-lE-…-round1.md` | round-1 reports (printed PASS; exit signal not certifiable) |
| `output/playwright/live/lD-head7a7a4d3-round{1,2,3}/*.png` | new virtual card, post-spend, over-limit refusal (3 per round) |
| `output/playwright/live/lE-head7a7a4d3-round{1,2,3}/*.png` | replacement card with `当前可支付金额 ¥70.00`, exhausted-allowance refusal (2 per round) |
| `output/playwright/REPORT-mock-suite.md` | mock suite: 23 journeys, exit code, DB file |
| `output/playwright/REPORT-date-tamper-boundary.md` | date-tamper: 9 cases, exact responses, DB file |
| `output/playwright/live/REPORT-l{A,B,C}-*.md`, `REPORT-lA-lC-round{1,2}.md` | earlier-cycle per-scenario reports (their provenance is in Git history) |
| `output/playwright/live/lB-head3ba488a-round1-merged/`, `output/playwright/live/lB-headd26b263-round2-final/` | `lB` rounds 1–2 (`head3ba488a` / `headd26b263`): `01-lB-investments-B0.png`, `02-lB-investments.png`, `03-lB-redeem-by-shares-panel.png`, `04-lB-bare-number-clarification.png` + `lB-evidence.json` + `lB-run-log.txt` |
| `output/playwright/live/lH-head3ba488a-round1-merged/`, `output/playwright/live/lH-headd26b263-round2-mfa-copy-fix/` | `lH` rounds 1–2: `01-lH-mfa-dock.png`, `02/03/04-lH-wrong-{1,2,3}.png`, `05-lH-locked-terminal.png`, `06-lH-after-reload.png`, `07-lH-security-center.png` + `lH-mfa-lock-evidence.json` + `lH-run-log.txt` |
| `output/playwright/live/lI-head3ba488a-round1-merged/`, `output/playwright/live/lI-headd26b263-round2-final/` | `lI` rounds 1–2: `01-lI-leg1-exact-phone-confirm.png`, `02-lI-leg4-masked-phone-rendering.png`, `03-lI-leg2-near-miss-refused.png`, `04-lI-leg3-card-tail-resolved.png` + `lI-evidence.json` + `lI-run-log.txt` |
| `output/playwright/live/lJ-head3ba488a-round1-merged/`, `output/playwright/live/lJ-headd26b263-round2-final/` | `lJ` rounds 1–2: `01-lJ-baseline-cards.png`, `02-lJ-second-virtual-card.png`, `03-lJ-transfer-cards.png`, `04-lJ-transfer-overview.png`, `05-lJ-frozen-card.png`, `06-lJ-lost-virtual-card.png` + `lJ-evidence.json` + `lJ-run-log.txt` |
| `output/playwright/live/lB-head6da00b8-round{3,4}/`, `output/playwright/live/lB-round{1,2,3}.png` | earlier `lB` rounds on `6da00b86` (screenshots only) and the three loose first-cycle screenshots — no `-evidence.json` / `-run-log.txt` archived alongside them |
| `output/playwright/live/lH-head0da121d-round{3,4}/`, `output/playwright/live/lH-head7e06a0d-round1-merged/`, `output/playwright/live/REPORT-lH-head0da121d-round4.md` | earlier `lH` rounds on `0da121d2` / `7e06a0d`; the report file records the round-2 session-lease flake and the pre-`d26b2636` dock copy |
| `output/playwright/live/lI-head7e06a0d-round3/` | earlier `lI` round on `7e06a0d` |
| `output/playwright/live/lJ-head7e06a0d-round1-merged/`, `output/playwright/live/lJ-head53fbde4-round{5,6}/RUN.md` | earlier `lJ` rounds on `7e06a0d` and `53fbde4`, the latter with their own `RUN.md` write-ups |
| `logs/` (git-ignored, untracked local path) | not repository evidence: `lB-CERTIFICATION.md`, `lB-diagnosis.md`, the round-based `lB*.log` / `dbcheck` scripts and `typecheck.log` exist only in the workspace that ran those rounds, so the `lB`/`lH`/`lI`/`lJ` references in this file resolve to each `output/playwright/live/<set>/*-evidence.json` and `*-run-log.txt` instead. |

Per-round screenshots live in `…-round<N>/` directories because the harness's fixed screenshot names are overwritten
by the next run.

## `lB` — investment net value and share accounting

Scenario id `lB` (`lB-live-investment-partial-redemption`), selected with `$env:LIVE_SCENARIOS='lB'`.
Each archived set is one process: freshly reprovisioned `prisma/live-acceptance.db`, real headless Chrome, live model,
and the whole stdout in `lB-run-log.txt` next to the screenshots and `lB-evidence.json`.
Round 1 (`lB-head3ba488a-round1-merged/`) ran on port `62079` and needed 10 model requests; round 2
(`lB-headd26b263-round2-final/`) ran on port `52442` and needed 6. Both logged
`== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` and `EXITCODE=0`.

**Prompts actually sent**, in order, each resolved without a nudge except B4 (which is meant to clarify):

```
B0 我的持仓
B1 追加申购稳健理财A 1000元
B2 我持有的稳健理财A按金额部分赎回2000元，保留剩余持仓
B3 我持有的稳健理财A按份额赎回 100 份
B4 赎回2000
```

**B0 — the holding is accounted by net value and shares, not by a stored market value.**
The chat card renders 持仓份额 `4999.864825` 份, 最新净值 `1.0357` 元/份, 市值 `¥5,178.36`, 持仓收益 `+¥178.36`,
持仓收益率 `3.56719998505%`; the DB carries `Holding.shares = 4999.864825` and an **unrounded** market value
`5178.3599992525`, i.e. `shares × latestNetValuePerUnit` evaluated on read, with the cent figure appearing only in the
rendering. `/investments` shows 持有金额 `¥5,000.00`, 剩余持仓成本 `¥5,000.00`, 持仓份额 `4999.864825`,
最新净值 `1.0357` 元/份, 市值 `¥5,178.36`, 持仓收益 `+¥178.36`, 累计收益 `+¥178.36`, 已实现收益 `¥0.00`.
Zero `pageerror` on this surface.

**B1 — an additional purchase is cost, never profit.** `追加申购稳健理财A 1000元` → `subscribe_investment` parks a RED
panel, `123456` is typed into the real MFA card, and the post-commit re-read is shares `5965.395384`, remaining cost
`6000.00`, market value `6178.3599992088`. The **chat card that the write turn projects** carries
持仓份额 `5965.395384` 份 — the post-write position, not the pre-write `4999.864825` — because the write projects the
holdings it just produced.

**B2 — an amount-based partial redemption converts through the net value.** `…按金额部分赎回2000元，保留剩余持仓` →
`redeem_investment` with an explicit `AMOUNT` mode → MFA → 赎回份额 `1931.061118` × 成交净值 `1.0357` = 到账 `2000.00`;
remaining shares `4034.334266`, remaining cost `4057.74` (this redemption removed `1942.26` of cost), market value
`4178.3599992962`, realized profit on this redemption `57.74`. The post-write chat card renders 持仓份额 `4034.334266` 份,
剩余持仓成本 `¥4,057.74`, 市值 `¥4,178.36`; `/investments` then shows 持有金额 `¥4,057.74`, 累计收益 `+¥178.36`,
已实现收益 `¥57.74`, 持仓收益 `+¥120.62`.

**B3 — a share-based redemption states its basis in the panel.** `…按份额赎回 100 份` → the real panel's fields, verbatim:

```
持仓       稳健理财A（holding_wenjiana）
操作       赎回名下理财持仓。
风险等级   🔴 红色
赎回口径   按份额赎回
赎回份额   100
成交净值   1.0357
净值日期   2026-09-25
预计到账金额 ¥103.57
费用口径   赎回费 ¥0.00（SIMULATED_NONE：模拟规则免收）
金额变化   净值、份额或到账金额变化时停止执行，需重新确认。
入账账户   活期账户
```

After `123456`: shares `3934.334266`, `principalAmountMinor = 395716`, `realizedProfitMinor = 6073`, one new
`CREDIT 103.57` ledger row, checking balance `24580.00` → `24683.57`.

**B4 — a bare number is not a redemption instruction.** `赎回2000` states no basis, so no `PendingAction` is created and
no panel appears; the clarification asks which product and which basis. Five surfaces are unchanged across the turn:
shares `3934.334266`, `principalAmountMinor 395716`, `realizedProfitMinor 6073`, status `HOLDING`, checking balance
`2468357` minor units, `Transaction` rows `235`, `PendingAction` rows `3` all `executed`, `AuditLog` rows `3`.
Round 1 asked it in two sentences, round 2 in three (product, basis) — the wording is model output, the refusal to act
is the product behaviour.

**Ledger shape of the whole flow**: exactly three investment rows — `−1000.00` (subscribing `稳健理财A`, category `投资`),
`+2000.00` (redeem) and `+103.57` (redeem) — three `AuditLog` rows and three `executed` `PendingAction` rows. The bare
number adds none of them.

**Evidence**: `output/playwright/live/lB-head3ba488a-round1-merged/` and `…-headd26b263-round2-final/`, screenshots
`01-lB-investments-B0.png`, `02-lB-investments.png` (investment surfaces after the write legs),
`03-lB-redeem-by-shares-panel.png` (the B3 panel above), `04-lB-bare-number-clarification.png` (the B4 clarification),
plus `lB-evidence.json` and `lB-run-log.txt`.

**Round ledger** (earlier rounds live on other product trees; none of them is one of the eight certified sets):

| Round | Product tree | Verdict | Exit | Note |
| --- | --- | --- | --- | --- |
| 1 (`7e66cee7`/`ec12289d`) | pre-`6da00b86` | PASS 1 / FAIL 0 / SKIP 0 | `0` | regression leg only — B3–B5 not covered |
| 2 (`89ea7891`) | pre-`6da00b86` | **PASS 0 / FAIL 1** | `1` | `B1 之后聊天里最新投资卡的持仓份额应为 5965.395384 份（写后重读的 DB 值），实际 4999.864825 份` — the read saw the pre-write card; the git-ignored local notes `logs/lB-CERTIFICATION.md` (not repository evidence) classify the round as a test-side race, while `logs/lB-diagnosis.md` records the same symptom as the then-missing write-tool projection in `agent/card-emitter.ts`. The certified rounds assert the post-write value. |
| 3, 4 (`6da00b86`) | `6da00b86` | PASS 1 / FAIL 0 / SKIP 0 each | `0` | full B0–B5; the two independent DB checks agree on shares `3934.334266`, `principalAmountMinor 395716`, `realizedProfitMinor 6073`, balance `2468357`, the three `投资` ledger rows and the three `executed` gate rows |
| 1 (`3ba488a`) | `3ba488a` | PASS 1 / FAIL 0 / SKIP 0 | `EXITCODE=0` | certified set, 10 model requests |
| 2 (`d26b2636`) | `d26b2636` | PASS 1 / FAIL 0 / SKIP 0 | `EXITCODE=0` | certified set, 6 model requests |

**Conclusion**: on both certified trees the holding renders from shares × latest net value, an additional purchase is
cost only, and a redemption is settled by the basis the panel declares, with one HALF_UP rounding to cents and an
unchanged state when no basis is given.
**Open**: the click-through of the B3 panel is asserted through its rendered fields and the resulting rows; the
stale-projection reading of the round-2 failure above is preserved as recorded, not resolved here.

## `lH` — MFA attempt limit, terminal lock and internal-marker containment

Scenario id `lH` (`lH-live-mfa-attempt-limit-lock-terminal`), body `live-mfa-lock.e2e-helper.ts`.
One process per round, fresh DB, real browser, live model:
`lH-head3ba488a-round1-merged/` (actionId `cmvkhghd80079p8f8nu12g6pt`) and
`lH-headd26b263-round2-mfa-copy-fix/` (actionId `cmvkhp0zi005nnsf88zip6m22`). Both
`== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`, `EXITCODE=0`.

**Chain**: a 🔴 transfer is parked by the gateway → three wrong codes `000000` are typed into the real dock → the
terminal lock → reload `/agent` → `/security`.

**The three verify responses are HTTP `200` domain results, never `423`/`409`**:

- `#1`, `#2` → `status='awaiting_mfa'`, top-level `code='MFA_FAILED'`,
  `failure={code:'MFA_FAILED', reason:'mfa_code_invalid', attemptsUsed:1|2, attemptsLeft:2|1, maxAttempts:3}`.
- `#3` → `status='locked'`, top-level `code='CIRCUIT_OPEN'`,
  `failure={code:'MFA_LOCKED', reason:'mfa_attempts_exhausted', attemptsUsed:3, attemptsLeft:0, maxAttempts:3}`.

**Remaining-attempt copy never renders zero**: after `#1`/`#2` the dock's counter line reads `「验证失败，已尝试 1 次。」` /
`「验证失败，已尝试 2 次。」`, and after `#3` the read-only receipt's current stage reads `「当前验证已锁定」`. The page never
prints `「还可尝试 0 次」` (`zeroAttemptsCopyHits = 0`), so `lib/public-text.ts#securityNotice`'s single `?? 0` default is
not reached on this path.

**Round 1 and round 2 differ in one copy mapping** — inside the dock, after a wrong code:

| Round | Dock badge text | Source |
| --- | --- | --- |
| 1 (`3ba488a`) | `请求失败，请检查网络后稍后重试。` | generic `chat.error.request` fallback (`publicToolError` had no mapping for `验证码错误。还可尝试 N 次。`) |
| 2 (`d26b2636`) | `验证码错误。还可尝试 1 次。` | the server message, rendered through the catalog |

That difference is exactly the `lib/tool-feedback.ts` delta between the two certified trees and is the only product
behaviour that changes across them.

**Terminal lock, asserted as server facts after the third wrong code**: `SELECTORS.mfaInput` count `0` and dock count `0`
(the dock unmounts in the same fold, so a zero count proves the unmount, not the terminal block), `GET /api/actions` no
longer contains the actionId, `PendingAction.status='locked'` with `resultJson=null`,
`MfaChallenge.attempts=3` / `status='locked'`, `CircuitBreakerState{key='user:user_liming', failures=3, locked=true}`.
The ledger gains nothing across the three attempts, and 58 internal-marker checks over the whole visible text and the
`verify` response bodies report `leakHits = 0` — no `__SECURITY_BLOCK__`, no `decisionKind`, no raw JSON, no stack.
The only place that marker does appear is the protocol layer the browser never renders:
`AgentSession.stateJson`'s `toolResult` text carries `__SECURITY_BLOCK__{"actionId":"…","decisionKind":"require_mfa"}`.

**After a reload of `/agent`** the lock persists: `[data-approval-history="true"][data-status="locked"]` with
`[data-approval-locked="true"]` (`lockedReceipts = 1`), one `[data-approval-stage="current"][data-stage-status="locked"]`
row (`lockedStages = 1`), `[data-approval-request="true"]` count `0`, `mfaInput` count `0`, no `「确认」`/`「验证」` button
in the dock, `PendingAction.status` still `locked`.

**`/security`** renders `[data-unlock-panel][data-unlock-locked="true"][data-unlock-failures="3"]
[data-unlock-max-attempts="3"][data-unlock-locked-actions="1"]`, three verbatim copy lines, the
`[data-lock-reason]` text, one `section[data-locked-actions] li[data-locked-action-id]` row and the
`CIRCUIT_BREAKER_TRIPPED` rows; `GET /api/security` reports `lock.code='CIRCUIT_OPEN'` with `failures=3`, and the DB
holds `SecurityEvent` `MFA_FAILURE` ×3 plus `CIRCUIT_BREAKER_TRIPPED` ×1.

**Evidence**: `output/playwright/live/lH-head3ba488a-round1-merged/` and
`output/playwright/live/lH-headd26b263-round2-mfa-copy-fix/`, seven screenshots each
(`01-lH-mfa-dock.png`, `02/03/04-lH-wrong-{1,2,3}.png`, `05-lH-locked-terminal.png`, `06-lH-after-reload.png`,
`07-lH-security-center.png`) plus `lH-mfa-lock-evidence.json` and `lH-run-log.txt`.

**Round ledger**: an earlier round on `0da121d2` ended exit 1 as a session-lease flake (first `POST /api/chat`
`500 INTERNAL`, then two `409 Another agent run owns this session`, the dock never appeared, `waitForMfaCard` timed out
at 90 s) with unchanged product and scenario code; the surrounding rounds on that tree passed, and the pre-`d26b2636`
dock copy above is documented in `output/playwright/live/REPORT-lH-head0da121d-round4.md`. `lH` does not reset the
breaker: it relies on the per-round reprovisioned database, so a second run on the same file starts already locked.

**Conclusion**: the attempt limit is terminal — the row is `locked`, the pending decision stops surfacing, the popup
never comes back after a reload, `/security` shows the owner-scoped breaker, and no internal marker reaches the page.
**Open**: `cards.mfa.failedAttemptsLimit` is unreachable in this path (the dock unmounts on the render that reaches the
terminal status), and the dock badge copy is proven only for the two wordings the two trees produced.

## `lI` — registering and resolving a phone number and a card number

Scenario id `lI` (`lI-live-identity-resolution`), body `live-identity.e2e-helper.ts`. Four legs in one process per
round: `lI-head3ba488a-round1-merged/` (6 model requests) and `lI-headd26b263-round2-final/` (7). Both
`== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`, `EXITCODE=0`.

**Leg 1 — an exact number resolves.** The full phone `13900000002` produces a real confirm card whose 收款人 is 张伟 and
whose 收款手机号 renders `139****0002`; cancelling that card leaves the checking balance at `23580.00` with no new
ledger row, so the panel is a real pre-execution panel.

**Leg 2 — a near-miss number is refused.** `13911110002` shares the visible ends with the seeded contact yet produces no
confirm card, **no new `transfer_money` `PendingAction`** (`[]`) and no movement; `search_contact` answers
`{"ok":true,"data":[]}` with `「未找到匹配…」`. Identity matching is on the complete number, not on a prefix/suffix shape.

**Leg 3 — a card tail resolves without a full number.** Tail `6688` produces a confirm card whose 卡片 field reads
`信用卡 ****6688`, matching the last four of `Card.numberFull` in the DB — the scenario never sends the full number.

**Leg 4 — nothing full is rendered.** No complete phone number and no complete card number appear in the confirm card,
in the assistant prose, in the tool-result text or in the persisted session JSON; the only surface carrying
`13900000002` is the user's own message bubble. Masks are the seeded ones (`card_credit` `****6688`, contact
`139****0002`).

**Model-side difference between the rounds** (both accepted, neither proving the other): round 1's model resolved the
card by id — `set_card_limit {"cardId":"card_credit","category":"餐饮","amount":"1000.00"}` — while round 2's used the
tail — `set_card_limit {"cardTail":"6688",…}`.

**Evidence**: `output/playwright/live/lI-head3ba488a-round1-merged/` and
`output/playwright/live/lI-headd26b263-round2-final/`, screenshots `01-lI-leg1-exact-phone-confirm.png`,
`02-lI-leg4-masked-phone-rendering.png`, `03-lI-leg2-near-miss-refused.png`, `04-lI-leg3-card-tail-resolved.png`
plus `lI-evidence.json` and `lI-run-log.txt`. An earlier round exists as
`output/playwright/live/lI-head7e06a0d-round3/`.

**Conclusion**: a complete number or an owned card tail resolves to a real parked action, a near-miss number resolves to
nothing, and every outward surface stays masked.
**Open**: two selector shapes are shown to work, not to be equivalent; and the masking claim covers the surfaces these
rounds read.

## `lJ` — a debit card displays its settlement account's balance

Scenario id `lJ` (`lJ-live-debit-card-linked-account-balance`). One process per round,
`lJ-head3ba488a-round1-merged/` and `lJ-headd26b263-round2-final/`, 10 model requests each, six screenshots each,
`== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` and `EXITCODE=0`.

**Baseline (`01-lJ-baseline-cards.png`)**: `card_debit` is `LINKED` to `活期账户` / `****8821` with
`accountAvailableBalance = 23580.00`, `payableAmount = 23580.00`, `usable = true` and **no credit fields**;
`/cards` renders 关联账户 `活期账户 · ****8821`, 账户余额 `¥23,580.00`, 可用余额 `¥23,580.00`, status 正常.
`card_virtual` shows the same `¥23,580.00` account balance with 可用余额 `¥5,000.00` (its monthly limit);
`card_credit` shows only 可用额度 `¥18,000.00` with no account row, and `「授信额度」` appears nowhere on the page.

**A second virtual card on the same account (`02-lJ-second-virtual-card.png`)** — `「请帮我新开一张虚拟卡，月消费限额设为100元」`
(resolved through a real RED panel + `123456`) → all three cards then show the identical account balance `¥23,580.00`,
the new card's 可用余额 is `¥100.00`, and `checkingBalance` / `totalAssets` do not move: opening a card moves no money
and the shared account is counted once.

**After a real transfer (`03-lJ-transfer-cards.png`, `04-lJ-transfer-overview.png`)** —
`「给张伟转12.34元」` → `transfer_money {"contactId":"contact_zhangwei","amount":"12.34"}` → balance `23580.00` →
`23567.66`. The same `¥23,567.66` then appears on every debit/virtual tile, in `GET /api/cards`
(`accountAvailableBalance = 23567.66`), in `/api/dashboard.checkingBalance` and on `/overview`, while `totalAssets`
drops by exactly `12.34` — one account, one balance, one deduction.

**A frozen card (`05-lJ-frozen-card.png`)** — `「请把我的借记卡冻结（我确认，可随时解冻）。」` → `status=FROZEN`,
`usable=false`, and the tile still renders the **real** balance `¥23,567.66` (账户余额 and 可用余额 both `¥23,567.66`)
with 已冻结 and `「卡片已冻结，暂不可用于消费（余额仍可查看）」`; the consume entry is disabled while `card_virtual` stays
usable. Unavailable is not zero.

**A lost card (`06-lJ-lost-virtual-card.png`)** — `「尾号7788的虚拟卡丢失了，请正式挂失，我确认不可撤销。」` → `status=LOST`,
`usable=false`, balance still `¥23,567.66`, 可用余额 `¥5,000.00`, 已挂失 and
`「卡片已挂失，暂不可用于消费（余额仍可查看）」`, consume disabled. The non-`LOST` `CREDIT` available total stays
`18000.00` and `totalAssets` is unchanged: a terminal card is not counted alongside anything, and 挂失/冻结 move no money.

**Evidence**: `output/playwright/live/lJ-head3ba488a-round1-merged/` and
`output/playwright/live/lJ-headd26b263-round2-final/` — `01-lJ-baseline-cards.png`, `02-lJ-second-virtual-card.png`,
`03-lJ-transfer-cards.png`, `04-lJ-transfer-overview.png`, `05-lJ-frozen-card.png`, `06-lJ-lost-virtual-card.png`
plus `lJ-evidence.json` and `lJ-run-log.txt`. The new virtual card and the transfer row are per-round:
`cardidem_51b2bb94d4887326f82062de24a604fe` / `txidem_c9e5a888ebaf5f7b6dccb67f80711fbb` in round 1,
`cardidem_f90d558f4df2a5ca9b0c0083fc2db718` / `txidem_b28a15d2e832d9dc16c970f3d946ab26` in round 2. Earlier rounds exist
as `output/playwright/live/lJ-head7e06a0d-round1-merged/` and `output/playwright/live/lJ-head53fbde4-round{5,6}/` (each
with its own `RUN.md`).

**Conclusion**: a DEBIT card projects the settlement account's cash, `payableAmount` for a VIRTUAL card is
`min(account cash, remaining monthly limit)`, multiple cards on one account share one balance counted once, and
`FROZEN`/`LOST` keep the real balance while refusing consumption.
**Open**: `MISSING` and `UNTRUSTED` bindings are not rendered on `/cards` by any round here.
