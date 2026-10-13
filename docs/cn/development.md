# 开发指南

项目使用 pnpm 管理依赖，使用 SQLite 保存模拟数据。
开发、测试和构建均从仓库根目录执行。
架构职责见[架构设计](architecture.md)。
文档术语见[术语表](terms.md)。

## 首次启动

运行环境要求如下：

| 项目 | 要求 |
| --- | --- |
| Node.js | 22.19.0 或更高版本 |
| pnpm | 12.3.4 |
| 浏览器 | 运行浏览器验收时，需要安装受支持的浏览器 |

版本声明见 [package.json](../../package.json)。
依赖变更需要更新 `pnpm-lock.yaml`。

依次执行以下命令：

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

打开 [http://localhost:3000/agent](http://localhost:3000/agent)。
`db:seed` 加载模拟账户、联系人和业务数据。
构建前也需要数据库，因为页面预渲染会查询数据。

警告：再次执行 `db:seed` 会重建演示用户的业务数据。
需保留数据时，先停止应用并备份数据库。
覆盖范围见[种子脚本](../../prisma/seed.ts)。

## 模型与环境配置

环境变量决定模型运行方式。
[配置入口](../../lib/config.ts)按调用时的环境读取配置。
[模型适配器](../../agent/providers/)解析模型和服务商。
变量模板见 [.env.example](../../.env.example)。

本地配置和密钥保存在 `.env.local`。
Next.js 和项目命令行入口自动加载这个文件。
进程环境变量优先于文件中的同名值。
密钥不得写入源码、日志或文档。

| 变量 | 含义与默认值 |
| --- | --- |
| `LLM_MODE` | `mock` 使用脚本模型；`live` 调用模型服务。默认使用 `mock`。 |
| `LLM_PROVIDER` | Pi 支持的服务商标识或自定义服务商。默认值为 `openai`。 |
| `LLM_MODEL` | 服务商内的模型标识。默认值为 `gpt-4o-mini`。 |
| `LLM_REQUEST_TIMEOUT_MS` | 在线请求超时。默认 30000 毫秒，范围为 1000 至 120000 毫秒。 |
| `DATABASE_URL` | SQLite 数据库地址。未设置时使用 `prisma/dev.db`。 |
| `DEMO_USER_ID` | 模拟用户标识。默认值为 `user_liming`。 |
| `MFA_MODE` | 未设置或设为 `demo` 时使用模拟多因子认证。其他值需要认证适配器。 |

DeepSeek 配置示例如下：

```dotenv
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
DEEPSEEK_API_KEY=<your-api-key>
```

在线适配器先查找服务商内的精确模型标识。
模型标识未注册时，已注册服务商使用自身默认模型。
适配器会输出配置模型和实际模型的差异。
当前锁定的 Pi 注册了 `deepseek-flash`。
这个模型使用 DeepSeek 自有地址。

自定义服务商需要显式配置地址。
地址取 `<PROVIDER>_BASE_URL`，其次取 `LLM_BASE_URL`。
密钥取 `<PROVIDER>_API_KEY`。
地址与鉴权代码见 [provider-live.ts](../../agent/providers/provider-live.ts)。

模拟多因子认证使用验证码 `123456`，不发送短信。
模型请求和金融命令的重试规则见[持久化与恢复](agent-durability.md)。

## 数据库管理

[schema.prisma](../../prisma/schema.prisma)定义当前数据结构。
数据库命令如下：

| 命令 | 用途 |
| --- | --- |
| `pnpm db:generate` | 生成与当前 schema 匹配的 Prisma Client。 |
| `pnpm db:push` | 将当前 schema 同步到配置的数据库。 |
| `pnpm db:seed` | 重建演示用户的业务数据，加载固定产品。 |
| `pnpm db:reset` | 重建配置的演示数据库，再加载模拟数据。 |
| `pnpm db:studio` | 打开 Prisma Studio 查看记录。 |

警告：`db:reset` 删除数据库及 SQLite 辅助文件。
重置前停止应用，并保存需要保留的数据。
重置仅允许仓库内的 SQLite 文件。
路径检查见 [db-push.ts](../../scripts/db-push.ts)。

修改 schema 后，先生成客户端，再同步数据库。
之后才能启动应用或构建。
项目仅支持当前 schema 和接口契约。

修改金额字段前，先读[金融数值](financial-values.md)。
字段名称、单位和精度也约束种子数据及测试数据。

## 页面入口

| 路径 | 用途 |
| --- | --- |
| `/` | 查看资产总览。 |
| `/agent` | 对话，查看结果和工作流卡片。 |
| `/actions` | 确认操作、提交验证码和恢复执行证据。 |
| `/manual` | 查看人工处理任务，记录操作员说明。 |
| `/runs` | 查看运行与工具调用状态，申请恢复。 |
| `/schedules` | 查看定时任务和提醒。 |
| `/bills`、`/cards`、`/subscriptions` | 查看账单、卡片和订阅。 |
| `/audit`、`/security` | 查看审计、安全事件和演示解锁控制。 |

HTTP 请求身份来自应用会话 Cookie。
模拟用户配置不等同于真实银行身份认证。
身份与授权规则见[安全设计](security.md)。

## 定时调度

调度命令每次检查一次到期任务：

```sh
pnpm scheduler:tick
```

无人值守运行需要主机调度器重复执行命令。
`/schedules` 页面也可发起检查。
到期付款仍需要新的确认或多因子认证。
时间覆盖参数见[定时任务](scheduled-tasks.md)。

## 崩溃恢复进程

恢复命令与 Web 服务分别启动：

```sh
pnpm agent:recover
pnpm agent:worker
```

`agent:recover` 执行一次恢复检查。
`agent:worker` 常驻运行，默认每 5 秒检查一次。
每次最多发现 25 个候选运行。
进程管理器需要同时管理 Web 服务和恢复进程。

可通过参数修改间隔和批量上限：

```sh
pnpm agent:worker --interval-ms 5000 --limit 25
```

间隔范围为 250 至 60000 毫秒。
批量上限范围为 1 至 100 个运行。

| 情况 | 恢复行为 |
| --- | --- |
| 原执行租约仍有效 | 等待租约到期，不接管执行。 |
| 原模型生成未完成 | 按原请求重新生成，遵守持久化重试上限。 |
| 独立工作流中断 | 读取保存的原图，恢复节点执行。 |
| 等待确认或多因子认证 | 保留原决定，等待用户操作。 |
| 金融写入结果无法证明 | 转入人工核对。 |
| 工作流暂停或等待人工处理 | 保留控制状态。 |

普通运行的执行租约为 120 秒。
独立工作流的执行租约为 600 秒。
模型续跑需要保留原服务商和模型配置。
独立工作流恢复不调用模型。
细节见[持久化与恢复](agent-durability.md)。

收到 `SIGINT` 或 `SIGTERM` 后，进程停止接收新恢复任务。
进程会等待正在恢复的任务结束。
`SIGKILL` 后，后续进程等待租约到期再接管。

检查输出只包含运行标识、状态和错误码。
并发执行冲突报告为 `busy`。
永久检查点错误报告持久化终态。

## 验证与构建

依次执行标准检查：

```sh
pnpm test
pnpm lint
pnpm build
pnpm typecheck
```

构建与类型检查需要顺序执行。
Next.js 构建会重建 `.next/types`。
类型检查也读取这个目录。

Vitest 使用 [tests/setup.ts](../../tests/setup.ts)建立 `prisma/test.db`。
数据库测试共享这个文件，并重置模拟数据。
[vitest.config.ts](../../vitest.config.ts)关闭了测试文件并行。
不得同时运行多个使用数据库的 Vitest 进程。

定向测试命令如下：

```sh
pnpm exec vitest run tests/unit/financial-values.test.ts
pnpm test:watch
```

浏览器验收独立于 Vitest：

```sh
pnpm exec tsx tests/e2e/acceptance.e2e.ts
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

离线验收使用 `prisma/e2e.db`。
在线验收使用 `prisma/live-acceptance.db`。
验收脚本准备模拟数据，并启动开发服务器。
`E2E_BROWSER_PATH` 可指定浏览器可执行文件。

注意：缺少浏览器时，测试旅程可能被跳过。
检查结果中的 `PASS`、`FAIL` 和 `SKIP` 数量。
在线验收需要网络和密钥，并产生模型请求费用。
测试范围见[测试说明](test-cases.md)。

验证进程需要顺序运行。
并行运行可能争用生成客户端或构建文件。

生产模式启动前，先准备当前数据库，再执行：

```sh
pnpm build
pnpm start
```

## 修改入口

按[架构设计](architecture.md)查找职责模块。
变更时需要同步维护以下契约：

| 变更 | 需要维护的内容 |
| --- | --- |
| 新增工具 | 工具目录、参数 schema、执行器和注册入口；声明效果、授权及重放规则。 |
| 新增金融写入 | 公共命令事务、可信执行上下文、必需审计和原执行回执。 |
| 修改工作流 | 编译检查、持久化所有权和检查点；验证确认、暂停、取消及恢复。 |
| 修改公开响应 | 接口契约、路由序列化和前端消费者。 |
| 修改契约 | 更新对应专题文档与测试。 |

工具目录见 [tool-catalog.ts](../../lib/contracts/tool-catalog.ts)。
工具执行器和注册入口位于 [agent/tools](../../agent/tools/)。
金融写入需验证重复请求、参数冲突和事务回滚。
事务规则见[持久化与恢复](agent-durability.md)。
金额和预算规则见[金融数值与结算](financial-values.md)。
公开金融输入和输出使用十进制字符串。
前端适配器按当前响应契约检查数据。

临时文件、脚本和日志保存在仓库内。
代码标识、新字符串字面量和代码注释使用英文。
