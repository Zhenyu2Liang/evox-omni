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

`live-acceptance.e2e.ts` 的 `SCENARIOS` 标识：`15,14,13,12,11,10,9,8,0,1,2,2p,3,5,6,4,lA,lB`。
选择 `2` 会同时选中 `2p`。
场景 `7`（`scenarioCommittedContinuationFailed`）不在 `SCENARIOS` 中，恒为最后阶段。
场景契约为 `{ id, name, run(ctx): Promise<string>, skipReason? }`，`run` 返回一条证据串。
新增场景：定义 `run`、加入 `SCENARIOS` 并使用唯一 `id`/`name`。
`driveRedTool`（`live-acceptance.e2e.ts:523`）用有界自然中文轮次驱动 RED 工具并提交 MFA `123456`。
`lA`（`scenarioCreditReplace`）经 `/agent` 挂失并补办信用卡，断言真实 `/cards` 页与 `GET /api/cards`，并验证二次补卡幂等。
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

## 退出码与已知问题

正常结束时退出码由 `reporter.failures` 决定：`live-acceptance.e2e.ts:1560` 与 `acceptance.e2e.ts:925` 执行 `process.exitCode = failures > 0 ? 1 : 0`。
但 `void main().catch(...)`（`live-acceptance.e2e.ts:1563`、`acceptance.e2e.ts:928`）以及 `uncaughtException`/`unhandledRejection` 处理器（`live-acceptance.e2e.ts:1453-1462`）都会强制退出码 1。
因此“打印 PASS 后仍非零退出”的路径是：主流程在多条 PASS 之后仍抛出未捕获异常/未处理 rejection。
live 入口最可疑的具体点是 `live-acceptance.e2e.ts:1556` 的 `console.log(await persistedRecipientCalls())`：它在 `try/finally`（`:1541` 已用 `cleanup()` 杀掉 dev server）之外、任何 try/catch 之外被 await，会打开一个新的 WAL Prisma 客户端读取刚被杀掉进程持有的同一 SQLite 文件；此处的 SQLite `disk I/O error`/WAL checkpoint 失败会拒绝 `main()` 并被 `:1563` 记为退出码 1（此时汇总行尚未打印）。
`:1557` 的 `readSeedRecipientPhone()` 内部 catch，安全。
`captureLive`（`live-acceptance.e2e.ts:363`）与 `captureScreenshot`（`helpers.ts:931`）整体 try/catch 包裹，截图写入本身不会外抛。
live 的 `cleanup()`（`:1430`）不 await `browser.close()`（`:1441` 为 fire-and-forget）且 `process.on('exit', cleanup)`（`:1444`）无法等待异步关闭；mock 入口 `acceptance.e2e.ts` 的 `finally` 会 `await browser.close()`（`:913-920`），两者不对称。

## 截图与日志

截图目录由 `SCREENSHOTS_DIR` 指定，当前为 `output/playwright`；live 截图写入其 `live/` 子目录（`live-acceptance.e2e.ts:359`）。
`LIVE-ACCEPTANCE-REPORT.md` 提到的 `tests/e2e/screenshots/live/` 与当前写入路径不一致。
文件日志统一放在仓库 `logs/`。

## 结果解释

`LIVE-ACCEPTANCE-REPORT.md` 是历史运行材料。
它不能代表当前提交已完成验收。
必须记录实际提交、模式、场景与本次运行结果。
live 超时或未发起业务必须按实际失败记录。
复跑成功不能抹去前次失败。

本地浏览器测试不证明集群并发或真实银行接入。
测试命令也不会自动完成生产构建验收。
