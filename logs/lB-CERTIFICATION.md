# lB（理财部分赎回）live 认证记录

- 场景注册名：`lB-live-investment-partial-redemption`，实现在 `tests/e2e/live-investment.e2e-helper.ts`（入口 `tests/e2e/live-acceptance.e2e.ts` 只做 import + 注册）。
- 代码 SHA（认证所用树）：`6da00b86`（产品修复 `7e66cee7` + `ec12289d`，卡片钩子 `72286add`，helper `422f7587`，接线 `89ea7891`，写后卡片有界轮询 `6da00b86`）。
- 运行命令（每轮，`timeout` 40 分钟，退出码用延迟展开法采集）：

```
cmd /v:on /c "set LIVE_SCENARIOS=lB&& set E2E_BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe&& pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lB-r<N>.log 2>&1 & set EC=!ERRORLEVEL! & echo EXITCODE=!EC! >> logs/lB-r<N>.log & exit !EC!"
```

| 轮次 | 代码 SHA | 退出码 | 汇总行 | 结果 |
| --- | --- | --- | --- | --- |
| round1 | `7e66cee7`+`ec12289d`（旧内联场景） | 0 | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` | PASS（回归证据，未覆盖 B3–B5） |
| round2 | `89ea7891`（新 helper 首跑） | 1 | `== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==` | FAIL：`B1 之后聊天里最新投资卡的持仓份额应为 5965.395384 份（写后重读的 DB 值），实际 4999.864825 份`（测试侧竞态，见 `logs/lB-r2.log`） |
| round3 | `6da00b86` | 0 | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` | PASS（B0–B5 全绿） |
| round4 | `6da00b86` | 0 | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` | PASS（B0–B5 全绿，连续第二轮） |

| round5 | `60bdcb05`（合并树 HEAD，独立 agent 复跑） | 0 | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` | PASS（B0–B5 全绿；B4 澄清措辞为**第三种**写法仍通过；DB 末态与 round3/round4 完全一致） |

- 认证双信号：round3 / round4 / round5 均为「退出码 0 + `PASS 1 ｜ FAIL 0 ｜ SKIP 0`」，且三轮 `累计网络 4xx/5xx：0，console error：0，pageerror：0`。
- round5 运行日志：`logs/a-lB-merged-head.log`（合并树独立复跑）、DB 核对 `logs/lB-rmerged.dbcheck.log`、截图 `output/playwright/live/lB-head60bdcb0-round5/`。round1 的失败复现证据为 `logs/a-lB-round1.log`（修复前 `pageerror: Financial value must be nonnegative.`）。`logs/lB-investment-partial-redemption-evidence.json` 为最近一次运行（round5）的证据 JSON。
- DB 核对：`logs/lB-r3.dbcheck.log`、`logs/lB-r4.dbcheck.log`（`logs/dbcheck-lB.ts` 生成），两轮结果一致：`holding_wenjiana` shares=3934.334266、principalAmountMinor=395716、realizedProfitMinor=6073、status=HOLDING；`acct_checking` balanceMinor=2468357；`category='投资'` 三条流水（-100000 / +200000 / +10357）；三条 `AuditLog` success；三条 `PendingAction` executed；每条 `ExecutionReceipt.responseJson` 都带写后 `holdings`。
- 截图：`output/playwright/live/lB-head6da00b8-round3/`、`output/playwright/live/lB-head6da00b8-round4/`（B0 持仓、B2 赎回后持仓、B3 按份额赎回确认面板、B4 裸数字澄清）。
- 逐条证据：`logs/lB-investment-partial-redemption-evidence.json`、`logs/lB-r3.log` / `logs/lB-r4.log` 的 PASS 行。

## 注意：本文件与 `logs/lB-r<N>.log` 才是权威记录

`logs/lB-round1.log`、`logs/lB-round2.log`、`logs/lB-round3.log` 及同名 `.dbcheck.log` 是更早一次场景修订留下的历史产物（数值与当前场景不符，例如 holding 成本 400000 分），不要当作本轮认证证据读取。