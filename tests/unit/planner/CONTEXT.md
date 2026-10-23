# 计划、对话状态与展示测试

## 范围

本目录包含 DAG 执行器测试，也包含对话展示测试。
名称不表示只验证计划模块。

| 测试组 | 关注点 |
| --- | --- |
| `dag`、`executor`、`lifecycle` | 图校验、执行顺序与控制 |
| `executor-claim-scope`、`executor-execution-right` | 数据库认领与失去执行权 |
| `intent-context`、`plan-compiler`、`plan-parameters` | 目的声明、参数与完整任务图 |
| `chat-stream`、`chat-transport-validation` | 流状态与传输校验 |
| `approval-record`、`action-attention-state` | 历史授权与待处理状态 |
| `chat-plan-history`、`plan-history-page` | 计划的历史归属 |
| `financial-display`、`chart-presentation` | 精确金额与图表显示 |
| `decimal-format`、`business-result-cards`、`investment-purchase-display`、`chat-read-results` | CNY 渲染字面量与业务结果卡 |
| `context-compaction`、`conversation-context` | 历史压缩与上下文恢复 |
| `scripted-provider` | 脚本化模型辅助模块自身 |

表内名称对应同名测试文件，扩展名为 `.test.ts`。
其余展示、诊断和条件边界以目录为准。

## 验证约束

纯执行器通过注入接口控制时间与副作用。
执行权测试使用真实数据库条件更新。
展示测试包含服务端渲染与状态转换。
它们不能代替浏览器点击和布局验证。

金额标签必须保留精确值。
图表坐标不能成为金融计算的输入。

运行：`pnpm exec vitest run tests/unit/planner`。
浏览器入口见 [../../e2e/CONTEXT.md](../../e2e/CONTEXT.md)。

## 回复修复与语义缺口

`reply-format.test.ts` 与 `reply-repair.test.ts` 只验证协议信封。
`inspectReplyFormat` 只识别 guidance、reasoning、assistant、tool envelope。
普通散文一律放行，不检查语义含义。
「散文声称面板却无受控工具调用」的策略不在本目录。
判定与纠正在 `agent/write-continuation.ts`，用例见 [../agent/CONTEXT.md](../agent/CONTEXT.md) 与 `tests/integration/write-continuation.test.ts`。
服务端确认面板只在该工具调用持久化 `PendingAction` 后出现。
会话策略测试只覆盖 mock 分类器，不覆盖真实模型散文。
`conversation-evidence.test.ts` 只拒绝散文作为查询证据，不涉及确认声明。

## 锁定结果的展示覆盖

渲染层锁定用例分两个文件，覆盖面不重叠：

| 文件 | 覆盖 |
| --- | --- |
| `tool-diagnostics.test.ts`（`renders locked verification and confirmation cards without actionable buttons`，L60） | 只断言 `cards.terminal.locked`、无 `<input>`、无 `<button>` |
| `locked-card-rendering.test.ts` | 锁定原因句与结构块：`MfaCard`/`ApprovalRecord` 的 `chat.error.actionLocked`、`data-mfa-locked`、`data-approval-locked`、`data-status="locked"`、`chat.approval.status.locked`、`href="/security"` 与 `pages.security.title`/`unlockDescription`；`status:'awaiting_mfa'` 对照仍有 `<input>`（验证码入口只在该尝试额度未耗尽时存在）；`security_event` 只按 typed `code`/`reason` 折叠成 `chat.error.actionLocked`/`chat.error.securityLocked`/`chat.error.securityDenied`；`settleAction{status:'locked'}` 清空 `pendingAction`、写 `settledActions[id]='locked'`、行内卡片转 `locked`，工具行摘要为 `chat.error.actionLocked`（`errorCode` 缺失时默认 `MFA_LOCKED`）或 `chat.error.securityLocked`，绝不为 `chat.error.toolFailed`；`MessageBubble` 把内部诊断转成 `chat.error.securityDenied` 且不吞掉普通系统消息 |

`chat.error.actionLocked` 原文含否定短语「无法继续验证或执行」，因此「锁定卡不得提供继续验证入口」按 `/验证` 与 `继续验证：` 判定，并额外断言该短语只出现在原因句内。
`chat.error.securityLocked` 只在该文件里经 `errorCode:'CIRCUIT_OPEN'` 的工具行与 `security_event` 命中。
工具行摘要的锁定文案同样只在 `locked-card-rendering.test.ts` 经 `publicToolSummary` 覆盖；`tool-feedback.test.ts` 只覆盖 `chat.error.toolFailed`。
`securityNotice` 的键级覆盖在 [../lib/CONTEXT.md](../lib/CONTEXT.md) 的 `public-text.test.ts`，不经过任何卡片渲染。

## 金额渲染字面量

`formatCNY`（`lib/money.ts`）与 `formatDecimalCNY`（`lib/decimal.ts`）的精确输出字面量只钉在两处：
`../financial-values.test.ts` 直调两个格式化器（`¥184,467,440,737,095,516.14`、`¥90,071,992,547,409.93`、`-¥0.20`、`-¥0.00`），
`decimal-format.test.ts` 经真实 `DecimalMoney` 组件渲染 markup（含 `1.005 → ¥1.01`、`2.675 → ¥2.68`、`0.999999999999999999 → ¥1.00`、`+¥118.91`、`-¥118.91`）。

同一文件也是仓库唯一渲染 `components/banking/HoldingFacts` 的用例（`describe('HoldingFacts signed 持仓收益率 rendering')`，`card`/`tile` 两种 layout，含 `profitRate` 缺失时不出 `%`）。
它不包 `LocaleProvider`（`LocaleProvider` 的默认上下文是 zh-CN），也不需要 `vi.mock('next/navigation')`；需要显式语言的用例见 `investment-purchase-display.test.ts` 的 `renderZh()`。
`financial-display.test.ts`、`chart-presentation.test.ts`、`chat-read-results.test.ts` 另钉 `+¥0.00`/`-¥0.00`、`¥46,116,860,184,273,879.04` 轴标签与 `-¥0.07`。
已知缺口：本目录与 `../financial-values.test.ts` 都没有 `formatCNY('0.00')` 的零值用例，也没有把 bigint 分为参数传进 `formatCNY` 的用例（唯一输入是大数经 `addMoney` 得到的元字符串）；零值只经 `DecimalMoney` 覆盖。
`business-result-cards.test.ts`、`investment-purchase-display.test.ts`、`security/gateway.test.ts` 用 `toContain(formatCNY(...))` 断言，期望值随实现计算，不构成字面量。

## 相关但不在本目录

`scripted-provider.test.ts` 只验证 `tests/helpers/scripted-provider.ts` 自身。
声明先作为首个 `describe_turn` 调用流式返回，随后按脚本顺序返回，`calls()` 把声明计入。
它不经过生产 `runTurn`、不建会话、不碰数据库。
需要「脚本化模型 → 生产 `runTurn` → SQLite 断言」的骨架时用 `tests/integration/write-continuation.test.ts`。

模型提案与逐轮声明测试位于 [../agent/providers/CONTEXT.md](../agent/providers/CONTEXT.md)。
包含 `mock-plan-proposals.test.ts` 与 `mock-turn-declaration.test.ts`。
完整参数写入产生真实工具调用，信息不足才走 clarification。
