# 真实浏览器验收

## 入口与隔离

| 入口 | 模型与数据库 |
| --- | --- |
| `acceptance.e2e.ts` | mock 模型，`prisma/e2e.db` |
| `live-acceptance.e2e.ts` | live 模型，`prisma/live-acceptance.db` |

两个入口都通过 playwright-core 驱动真实浏览器。
它们启动独立服务，准备隔离数据库并清理子进程。
不得指向用户正在使用的数据库。
凭据通过运行环境加载，不写入日志或测试报告。
`live-acceptance.e2e.ts` 用 Next 的 `loadEnvConfig` 载入运行环境。
live 数据库文件为 `prisma/live-acceptance.db`（含 `-wal`/`-shm`/`-journal` 侧车），先 `prisma db push` 再 probe 再 `tsx prisma/seed.ts`。
`withDb` 通过 `lib/db/database.ts#createDatabaseClient` 打开一次性 Prisma 客户端做权威 DB 交叉核对（连接时设 `PRAGMA journal_mode = WAL`）。

## 运行

`pnpm exec tsx tests/e2e/acceptance.e2e.ts`
运行离线浏览器场景。
`E2E_JOURNEYS` 可指定场景名称列表。
实际场景以入口的 `JOURNEYS` 为准。

`pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
运行真实模型场景。
`LIVE_SCENARIOS` 可指定场景标识列表。
`LIVE_FORCE_MODEL` 仅在显式配置时覆盖模型。

`E2E_BROWSER_PATH` 可指定 Chrome 或 Edge 路径。
找不到浏览器时，入口记录跳过。
必须检查 PASS、FAIL 与 SKIP，不能只看退出码。
`E2E_SKIP_DB_RESET=1` 保留库，不保证场景起点一致。

## live 场景与辅助模块

`live-acceptance.e2e.ts` 的 `SCENARIOS` 标识：`15,14,13,12,11,10,9,8,0,1,2,2p,3,5,6,4,lA,lB,lC`。
选择 `2` 会同时选中 `2p`。
场景 `7`（`scenarioCommittedContinuationFailed`）不在 `SCENARIOS` 中，恒为最后阶段。
场景契约为 `{ id, name, run(ctx): Promise<string>, skipReason? }`，`run` 返回一条证据串。
新增场景：定义 `run`、加入 `SCENARIOS` 并使用唯一 `id`/`name`。
`driveRedTool`（`live-acceptance.e2e.ts:523`）用有界自然中文轮次驱动 RED 工具并提交 MFA `123456`。
`lA`（`scenarioCreditReplace`）经 `/agent` 挂失并补办信用卡，断言真实 `/cards` 页与 `GET /api/cards`。
`lA` 的二次补卡腿只用确定性 `GET /api/cards` 核对（仍恰 3 张、唯一 ACTIVE 信用卡 id 不变），允许模型重放、返回既有结果或明确拒绝，不要求再次生成 MFA。
`lB`（`scenarioPartialRedeem`）经 `/agent` 追加申购再部分赎回理财，断言 `/investments`、账本与 `holding_wenjiana` 的 `principalAmountMinor`/`estimatedMarketValue`。

场景覆盖业务决定、刷新、恢复、人工接管与对话历史。
还覆盖本地化、移动布局、卡片管理和开发者模式。
还覆盖理财申购与赎回（离线入口 `h-investment-flow`）以及理财页面（`journeyBankingPages` 访问 `/investments`）。
涉及资金变化时，同时核对页面、余额与流水。
具体辅助模块使用 `*.e2e-helper.ts` 命名。

`helpers.ts` 提供服务启动、数据库准备与 DOM 操作。
交互前等待水合完成。
读取共享演示会话使用 `readDemoSessionId`（读 `[data-demo-session-id]` 属性）。
不得等待不存在的认证 Cookie。
当前授权面板与历史授权记录必须分别定位。

## LIVE 叙述与确认面板

LIVE 模型偶尔只叙述「请确认」并调用 `search_contact`，却不调用受控工具，因此不产生 `PendingAction`，无确认/MFA 卡片，`/api/actions` 为空。
`live-acceptance.e2e.ts#driveRedTool` 在受限自然轮次内检测「无卡片」并发送下一条自然语言催促。
`panel-claim.e2e-helper.ts#findConfirmationPanelClaim` 是纯文本匹配，判定助手散文是否声称确认/MFA 面板已存在（`确认面板`/`验证面板`/`上方面板`/`已在面板`/`等待你的确认` 等，否定表述不算）。
`helpers.ts#assertNoFabricatedConfirmationPanel` 在散文声称面板却 `/api/actions` 无待处理项且 DOM 无确认/MFA 卡片时显式判定失败，错误信息区分 cause=模型未发起受控工具（模型行为）与 cause=UI/测试原因（网关已停放动作但未渲染）。
该守卫接入 `driveRedTool`（散文轮次）与场景 7 的 park 轮询。
普通追问（模型仅问「是否确认…」而未声称已有面板）不触发守卫，仍按现有逻辑继续催促。
场景 7 用 `PARK_ATTEMPTS`/`PARK_NUDGES` 轮询 `/api/actions` 并催促（见 `LIVE-ACCEPTANCE-REPORT.md` 的 Blockers）。

## MFA 验证码与熔断覆盖

`acceptance.e2e.ts` 的 `j-circuit-breaker-lock` 在同一会话内连续提交 3 次错误验证码（每次 `submitMfa('000000')`），
断言 `cards.terminal.locked`（已锁定）且验证码输入框 `SELECTORS.mfaInput` 消失，
随后切换到 `/security` 核对已熔断并在该页刷新验证持久化；三次尝试之间不刷新页面。
`e2-refresh-mfa`（journey e）断言挂起但未锁定的红档转账刷新后 MFA 卡片恢复。
`live-acceptance.e2e.ts` 的 S4 只提交一次错误码并断言卡片保留，正确码在独立页面执行；live 侧不校验尝试次数上限。
当前没有用例在锁定后刷新 `/agent` 再断言弹窗保持消失。

## 退出码与资源清理

正常结束时退出码由 `reporter.failures` 决定：两个入口都在场景结束后打印汇总并执行 `process.exitCode = failures > 0 ? 1 : 0`。
只有「场景断言 + 证据落盘 + 资源清理全部成功」的正常路径才 exit 0，退出码与真实通过/失败一致。
两个入口在 `finally` 中 `await browser.close()`（捕获异常）。
live 入口拆出可 await 的 `teardown()`（先停 `server.current ?? devServer`，再关浏览器），`process.on('exit')` 与信号处理器使用同步兜底 `cleanup()`。
live 入口的场景后诊断与 TASK-A 证据读取位于主 `try` 内、`cleanup` 之前，并用 try/catch 包裹（仅告警、不改退出码），证据读取失败不会把通过的运行变成 exit 1。
`uncaughtException`/`unhandledRejection` 处理器仍是真正的失败路径（exit 1）。

## 截图与日志

截图目录由 `SCREENSHOTS_DIR` 指定，当前为 `output/playwright`；live 截图写入其 `live/` 子目录。
文件日志统一放在仓库 `logs/`。

## 结果解释

`LIVE-ACCEPTANCE-REPORT.md` 是历史运行材料。
它不能代表当前提交已完成验收。
必须记录实际提交、模式、场景与本次运行结果。
live 超时或未发起业务必须按实际失败记录。
复跑成功不能抹去前次失败。

本地浏览器测试不证明集群并发或真实银行接入。
测试命令也不会自动完成生产构建验收。

## 已知失败断言（mock 入口 acceptance.e2e.ts）

`c-plan-pause-resume`（`journeyPlanPauseResume`，`acceptance.e2e.ts:290`）与
`j-circuit-breaker-lock`（`journeyCircuitBreakerLock`，`acceptance.e2e.ts:694`）在 mock 入口稳定失败，根因均在业务源，非测试侧：

- 计划节点标签：`PLAN_NODE_ANALYZE = '查询消费情况'`（`acceptance.e2e.ts:131`，断言于 `:299` 的 `waitForNodeStatus`）无任何源产生。
  mock 计划把 analyze 节点命名为英文字面量 `'Analyze spending'`（`agent/providers/mock/plan-intents.ts:42,52`）。
  该名字经 `agent/tools/plan-compiler.ts` 原样落库为 `TaskNodeSpec.name`，由 `components/banking/AgentTaskTimeline.tsx:106` 经 `localizeToolLabel` 渲染（`helpers.ts:1445` 读该 `span`）。
  `localizeToolLabel` 查 `chat.tool.Analyze spending` 无此键，回退 `lib/i18n/messages/display-sources.json#tools`（其键为中文，如 `"消费分析": "chat.tool.analyze_spending"`），故原样透出→渲染为 `Analyzespending`，断言 90s 超时。
  正确修复需改 `agent/providers/mock/plan-intents.ts` 或补 i18n 映射（业务源）。
- MFA 失败状态：`acceptance.e2e.ts:721` 等待 `cards.mfa.failedAttempts`（`lib/i18n/messages/chat.zh-CN.json:137` = `验证失败，已尝试 {attempts} 次。`）。
  实际渲染的是 `cards.mfa.failedAttemptsLimit`（`chat.zh-CN.json:138` = `验证失败，已尝试 {attempts} 次，最多 {maxAttempts} 次。`）——
  `components/chat/ChatWindow.tsx:238` 恒传 `maxAttempts={MFA_MAX_ATTEMPTS}`（`lib/constants.ts:10` = 3），使 `components/chat/cards/MfaCard.tsx:96-98` 永远走 limit 分支。
  因 `waitForStatusText`（`helpers.ts:1182`，去空白后 `includes`）匹配 `...已尝试1次。` 而非 `...已尝试1次，最多3次。`，首个错误码即超时。`failedAttempts` 明文在 live dock 中从不渲染。
