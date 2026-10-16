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

## 断言与辅助模块

场景覆盖业务决定、刷新、恢复、人工接管与对话历史。
还覆盖本地化、移动布局、卡片管理和开发者模式。
还覆盖理财申购与赎回（离线入口 `h-investment-flow`）以及理财页面（`journeyBankingPages` 访问 `/investments`）。
真实模型入口（`live-acceptance.e2e.ts`）当前未覆盖理财工具。
涉及资金变化时，同时核对页面、余额与流水。
具体辅助模块使用 `*.e2e-helper.ts` 命名。

## LIVE 叙述与确认面板

LIVE 模型偶尔只叙述「请确认」并调用 `search_contact`，却不调用受控工具，因此不产生 `PendingAction`，无确认/MFA 卡片，`/api/actions` 为空。
`live-acceptance.e2e.ts#driveRedTool` 在受限自然轮次内检测「无卡片」并发送下一条自然语言催促（如「界面上方没有出现确认面板，请重新发起…」）。
场景 7 用 `PARK_ATTEMPTS`/`PARK_NUDGES` 轮询 `/api/actions` 并催促（见 `LIVE-ACCEPTANCE-REPORT.md` 的 Blockers）。
`noCardDiagnostics` 在超时时区分「模型仅叙述未调用工具」与「UI/测试原因」，但等待与断言本身不弱化。
当前没有用例在模型虚假声称「已在面板确认」而无工具调用时断言失败；该情形只被催促绕过或最终超时。

## MFA 验证码与熔断覆盖

`acceptance.e2e.ts` 的 `j-circuit-breaker-lock` 在同一会话内连续提交 3 次错误验证码（每次 `submitMfa('000000')`），
断言 `cards.terminal.locked`（已锁定）且验证码输入框 `SELECTORS.mfaInput` 消失，
随后切换到 `/security` 核对已熔断并在该页刷新验证持久化；三次尝试之间不刷新页面。
`e2-refresh-mfa`（journey e）断言挂起但未锁定的红档转账刷新后 MFA 卡片恢复。
`live-acceptance.e2e.ts` 的 S4 只提交一次错误码并断言卡片保留，正确码在独立页面执行；live 侧不校验尝试次数上限。
当前没有用例在锁定后刷新 `/agent` 再断言弹窗保持消失。

`helpers.ts` 提供服务启动、数据库准备与 DOM 操作。
交互前等待水合完成。
读取共享演示会话使用 `readDemoSessionId`。
不得等待不存在的认证 Cookie。
当前授权面板与历史授权记录必须分别定位。

安全中心重置按钮调用开发者专用接口。
该按钮没有验证码输入框。
业务验证与公共解锁接口采用各自策略。

截图目录由 `SCREENSHOTS_DIR` 指定，当前为 `output/playwright`。
文件日志统一放在仓库 `logs/`。

## 结果解释

`LIVE-ACCEPTANCE-REPORT.md` 是历史运行材料。
它不能代表当前提交已完成验收。
必须记录实际提交、模式、场景与本次运行结果。
live 超时或未发起业务必须按实际失败记录。
复跑成功不能抹去前次失败。

本地浏览器测试不证明集群并发或真实银行接入。
测试命令也不会自动完成生产构建验收。
