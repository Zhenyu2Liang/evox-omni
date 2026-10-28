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
只提交 `pnpm-lock.yaml`，不引入 npm 或 Yarn 的锁文件。

依次执行以下命令：

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。
首页默认进入 AI 助手。
页面打开时直接进入固定演示用户的共享对话，无需登录。
不同浏览器使用同一会话，刷新后恢复已保存的记录。
`db:seed` 加载模拟账户、联系人和业务数据。
构建前需要生成 Prisma Client。业务页按请求读取数据。

警告：再次执行 `db:seed` 会重建演示用户的业务数据。
需保留数据时，先停止应用并备份数据库。
覆盖范围见[种子脚本](../../prisma/seed.ts)。

## 界面语言

界面支持中文和英文，首次打开时默认中文。
桌面端在侧边栏底部切换语言。
移动端在顶部切换语言。
选择保存在 `banking_locale` Cookie 中，有效期为 1 年。
刷新页面和切换业务页后，继续使用所选语言。

[语言资源](../../lib/i18n/messages/)按职责分为 4 组：

| 文件前缀 | 内容 |
| --- | --- |
| `app` | 导航、布局和通用提示 |
| `chat` | 助手、业务卡片和图表 |
| `business` | 业务组件、任务和运行记录 |
| `pages` | 服务端业务页 |

每组包含 `zh-CN` 和 `en`，两份资源的键与参数需一致。
客户端使用 `useI18n()`，服务端使用 `getServerI18n()`。
完整文案用 `{name}` 参数插值，金额传入已精确格式化的文本。
未知服务端状态显示原值。
历史对话、交易事实和用户输入保留原文。

切换语言后，客户端刷新服务端组件。
对话状态保留，银行操作不会重新提交。
根布局读取语言 Cookie，因此页面按请求渲染。
代码入口见 [lib/i18n](../../lib/i18n/)。

## 模型上下文配置

完整对话保存在数据库中。
模型请求超过阈值时，系统生成摘要并保留近期完整轮次。
归档查询可以恢复摘要中遗漏的原话。

| 环境变量 | 默认值 | 单位 |
| --- | --- | --- |
| `AGENT_COMPACTION_THRESHOLD_TOKENS` | `60000` | 估算 token 数。 |
| `AGENT_COMPACTION_RESERVE_TOKENS` | `8192` | 预留 token 数。 |
| `AGENT_COMPACTION_KEEP_RECENT_TOKENS` | `12000` | 近期轮次目标 token 数。 |
| `AGENT_COMPACTION_SUMMARY_TOKENS` | `2048` | 摘要输出 token 上限。 |

token 是模型处理文本的计量单位。
配置使用 `128` 到 `1000000` 的整数。
实际阈值还受所选模型上下文容量限制。
修改后重启服务，使后续模型请求使用新配置。
已有模型请求恢复时保留原输入。

项目直接调用 Pi Coding Agent `1.2.0` 的公开 `compact()`。
摘要提示词、历史序列化和生成流程由官方函数负责。
Pi Core 的请求准备和上下文转换钩子接入摘要视图。
银行适配层继续保存完整归档、压缩事件和检查点。
近期消息按完整用户轮次保留。
摘要可以遗漏细节，`search_conversation_history` 查询完整原文。
摘要生成失败后，只重试只读摘要请求。
压缩不会授权或重跑银行业务。
单个模型请求仍受模型容量限制。
超出容量的近期轮次保留原文，并报告容量不足。
详细规则见[上下文压缩](context-compaction.md)。

## 验证目录

开发服务默认使用 `.next`。
浏览器验收服务使用 `.next-e2e`，避免覆盖开发缓存。
开发服务运行时，可将生产构建输出到独立目录：

```sh
BANKING_NEXT_DIST_DIR=.next-build pnpm build
BANKING_NEXT_DIST_DIR=.next-build pnpm start
```

构建和启动需使用相同目录。
日志统一写入 `logs/`。

## 开发页面反复刷新

开发服务通过热更新连接同步代码版本。
如果连接反复报告 `HMR hash mismatch`，浏览器会不断重新加载页面。
版本不一致可能来自旧开发缓存，需要通过新缓存对照检查。

1. 停止使用该缓存目录的开发服务。
2. 将默认开发缓存 `.next/dev` 改名备份。
3. 运行 `pnpm dev`，重新生成开发缓存。
4. 打开助手页，确认输入内容不会因整页重载而丢失。

仅处理开发缓存，不重置数据库、微信登录或业务记录。
使用 `BANKING_NEXT_DIST_DIR` 时，处理对应目录下的 `dev` 缓存。
不要移动仍被其他服务使用的缓存目录。

项目允许 `localhost` 和 `127.0.0.1` 访问开发资源。
后者在 `next.config.mjs` 的 `allowedDevOrigins` 中显式列出。
如果仅使用 `127.0.0.1` 时热更新连接被拒绝，先核对该配置。
关闭热更新连接不能作为页面稳定的验收依据。

网页和微信同时使用时，分别运行 `pnpm dev` 与 `pnpm weixin:start`。
微信通道调用银行 HTTP 接口，两进程共用银行服务的数据。
微信登录及手机收发检查见[微信通道](weixin.md)。

## 初始页面的 hydration 告警

hydration 指 React 接管服务端生成的页面。
浏览器扩展或集成可能在接管前给 `<html>` 添加属性。
例如 `data-redeviation-bs-uid` 并非项目生成的属性。
服务端没有该属性，浏览器侧有该属性时，会触发告警。

根布局使用 `suppressHydrationWarning` 容忍这一层差异。
业务组件仍保留 hydration 检查。
语言一致性由中文默认值和中英切换验收检查。
回归用例模拟接管前的外部属性注入。
用例见 [hydration.e2e-helper.ts](../../tests/e2e/hydration.e2e-helper.ts)。

Next.js 提供页面渲染、导航、HTTP 路由和 Cookie 读取。
银行 SDK、权限和运行持久化模块不依赖 Next.js。
删除框架依赖前，需要替换这些 Web 入口。

### 原生数据库模块

开发服务继续使用 Next.js 默认的 Turbopack。
[next.config.mjs](../../next.config.mjs)为以下依赖保留 Node.js 加载：

- `@prisma/client`。
- `@prisma/adapter-better-sqlite3`。
- `better-sqlite3`。

SQLite 适配器和原生驱动需要正确的模块文件位置。
只排除 Prisma 客户端，仍会让打包器处理适配器。
原生绑定的定位可能因此失败，页面无法读取数据库。
适配器也必须放入 `serverExternalPackages`。
这项配置同时用于开发服务和生产构建。

修改原生模块加载配置后，停止并重新启动开发服务。
仅刷新浏览器不会替换已经加载的服务端模块。
验收服务使用独立的 `.next-e2e` 和隔离数据库。
启动过程被中断时，验收进程也会清理已创建的开发服务。
日常开发服务与验收服务使用不同的输出目录。

## 依赖构建脚本权限

[pnpm-workspace.yaml](../../pnpm-workspace.yaml)保存构建脚本权限。
`allowBuilds` 的值必须是 `true` 或 `false`。
占位文字表示尚未决定，不能作为批准结果。
pnpm 的严格构建检查会拒绝未审阅的依赖脚本。
规则见 [pnpm 构建设置](https://pnpm.io/settings/build#allowbuilds)。

| 依赖 | 批准 | 原因 |
| --- | --- | --- |
| `@prisma/engines` | `true` | 准备 CLI 同步表结构所需的引擎 |
| `better-sqlite3` | `true` | 准备 SQLite 原生驱动 |
| `prisma` | `true` | 检查 CLI 运行环境 |
| `esbuild` | `true` | 准备并校验平台二进制文件 |
| `unrs-resolver` | `true` | 准备 ESLint 解析器使用的原生绑定 |
| `@google/genai` | `false` | 当前安装钩子仅打印无操作信息 |
| `protobufjs` | `false` | 安装钩子检查依赖版本写法，不生成运行文件 |

依赖更新出现新的构建脚本时，先阅读脚本内容。
再按项目需要更新权限表。
安装已完成但脚本曾被跳过时，执行以下命令：

```sh
pnpm rebuild @prisma/engines better-sqlite3 esbuild prisma unrs-resolver
pnpm install --frozen-lockfile
```

## 依赖职责

直接依赖均有代码入口，按职责保留。
依赖清单见 [package.json](../../package.json)。

| 依赖 | 用途 |
| --- | --- |
| `next`、`react`、`react-dom` | 页面、服务端路由和交互组件 |
| `@next/env` | 独立脚本使用 Next.js 的环境加载规则 |
| `@earendil-works/pi-agent-core` | 对话与工具循环 |
| `@earendil-works/pi-ai` | 模型契约、服务商和流式响应 |
| `@earendil-works/pi-coding-agent` | 通过公开 `compact()` 复用官方上下文压缩 |
| `@prisma/client` | 生成客户端使用的运行时 |
| `@prisma/adapter-better-sqlite3` | Prisma 与 SQLite 原生驱动之间的适配器 |
| `decimal.js` | 精确数值运算与结算 |
| `zod` | 请求、工具和运行结果检查 |

`@next/env` 与 Next.js 使用相同版本。
种子、数据库同步和后台 worker 直接导入该包。
pnpm 的依赖隔离要求声明这些直接导入。
删除声明会导致独立脚本找不到模块。

Pi 的 3 个直接依赖固定为 `1.2.0`。
Coding Agent 的 `AgentSession.compact()` 属于编码会话 SDK。
项目使用公开的底层 `compact()`，会话状态继续保存在 Prisma。
项目不创建文件会话管理器或启动编码命令行会话。
银行工具注册表不注册文件、Shell 或编码工具。

Coding Agent 的 npm 包还包含命令行与终端界面依赖。
传递依赖还包括模型上下文协议（MCP）和 Photon 图像库。
安装范围包含整个 npm 包，不能按单个压缩函数估算。
升级依赖后需验证官方接口、归档保留及崩溃恢复。
分工与依赖代价见[上下文压缩](context-compaction.md)。

`@google/genai` 是 Pi AI 的传递依赖。
项目没有直接调用 Google SDK。
只使用 DeepSeek 时，SDK 不参与模型请求。
禁止该包的安装脚本不等于删除其运行文件。
详情见 [Pi AI 依赖声明](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/package.json)。

消费图表使用 React 和原生 SVG。
项目已移除 Recharts 及其专用传递依赖。
图表提示保留精确金额字符串。
轴标签和中点使用精确数值运算。
浮点转换只用于图表坐标。

Prisma CLI、TypeScript 和 tsx 用于开发与脚本。
ESLint、Vitest 和 Playwright 用于代码检查与验收。

## 依赖版本与升级

当前版本核对日期为 `2026-10-29`。
项目固定已验证的依赖版本，安装时使用锁文件。
后续升级需要重新验证接口和数据库事务。

| 依赖 | 固定版本 |
| --- | --- |
| Pi Core、Pi AI、Pi Coding Agent | `1.2.0` |
| Next.js、环境加载器及 Next.js ESLint 插件 | `16.4.3` |
| React、React DOM | `19.3.0` |
| Prisma CLI、运行时及 SQLite 适配器 | `7.10.1` |
| TypeScript 编译器 | `7.0.2` |
| TypeScript 程序接口适配包 | `@typescript/typescript6@6.0.2` |
| Vitest | `5.0.4` |
| Tailwind CSS、PostCSS 插件 | `4.3.3` |
| ESLint | `10.12.0` |
| Zod | `4.6.7` |

完整版本见 [package.json](../../package.json)。
传递依赖版本见 [pnpm-lock.yaml](../../pnpm-lock.yaml)。
Prisma 8 的 RC 属于预发布版本。
项目采用稳定版本 `7.10.1`。
传递依赖的固定替换配置见 [pnpm-workspace.yaml](../../pnpm-workspace.yaml)。
升级时同时检查该配置和锁文件，并执行 `pnpm audit`。
审计通过只表示当次漏洞数据库没有报告命中的已知漏洞。

TypeScript 7.0 提供原生编译器 `tsc`。
该版本尚未提供稳定程序接口。
ESLint 等工具仍需要 TypeScript 6 的程序接口。
项目按[微软的并行安装方案](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)声明 2 个别名。

```json
{
  "@typescript/native": "npm:typescript@7.0.2",
  "typescript": "npm:@typescript/typescript6@6.0.2"
}
```

`pnpm typecheck` 使用 TypeScript 7 的 `tsc`。
导入 `typescript` 的工具取得官方 TypeScript 6 适配包。
此安排将编译检查与工具程序接口分开。

`pnpm lint` 直接运行 ESLint。
规则保存在 [eslint.config.mjs](../../eslint.config.mjs)。
Next.js 规则和 React Hooks 规则在该文件启用。
Tailwind CSS 使用 `@tailwindcss/postcss` 插件。
全局样式直接导入 `tailwindcss`。

更新依赖后，依次执行以下命令：

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

schema 变更另需执行 `pnpm db:push`。
普通依赖升级无需重建演示业务数据。
Prisma 7 的生成与驱动规则见[数据库管理](#数据库管理)。

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
| `BANKING_ALLOWED_ORIGINS` | 逗号分隔的完整可信地址。未设置时仅允许本机地址。 |
| `MFA_MODE` | 未设置或设为 `demo` 时使用模拟多因子认证。其他值需要认证适配器。 |

DeepSeek 配置示例如下：

```dotenv
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
DEEPSEEK_API_KEY=<your-api-key>
```

在线适配器先查找服务商内的精确模型标识。
模型标识未注册时，适配器报错，不替换为其他模型。
如需使用未注册的模型，必须显式配置兼容 OpenAI 接口的服务地址。
当前锁定的 Pi 注册了 `deepseek-flash`。
这个模型使用 DeepSeek 自有地址。

自定义服务商需要显式配置地址。
地址取 `<PROVIDER>_BASE_URL`，其次取 `LLM_BASE_URL`。
密钥取 `<PROVIDER>_API_KEY`。
地址与鉴权代码见 [provider-live.ts](../../agent/providers/provider-live.ts)。

模拟多因子认证使用验证码 `123456`，不发送短信。
模型请求和金融命令的重试规则见[持久化与恢复](agent-durability.md)。

## 可信访问地址

本地开发可使用 `localhost`、`127.0.0.1` 或 `[::1]`。
使用其他域名时，在服务端环境中设置完整地址。
例如，公开入口为 `https://banking.example.com`：

```dotenv
BANKING_ALLOWED_ORIGINS=https://banking.example.com
```

地址包含协议及非默认端口，不包含路径、查询参数或片段。
多个地址用逗号分隔；配置后也需显式列出仍要使用的本机地址。
例如，同时允许公开入口与本机调试：

```dotenv
BANKING_ALLOWED_ORIGINS=https://banking.example.com,http://localhost:3000
```

反向代理需保留公开入口的 `Host`。
HTTPS 可在代理层终止，代理到应用之间可使用 HTTP。
未知域名被拒绝时，检查配置和代理的 Host 转发。
拒绝规则覆盖页面、API 和静态资源，详见[安全设计](security.md#http-请求边界)。
可信地址配置不提供用户登录或角色分权。

## 单轮模型调用预算

一次用户输入的模型请求共用以下上限。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `AGENT_MAX_MODEL_REQUESTS` | `32` | 模型请求及实际 HTTP 重试的总次数 |
| `AGENT_MAX_MODEL_TOKENS` | `2000000` | 输入与最大输出的累计预留 token 数 |
| `AGENT_MAX_TURN_MS` | `300000` | 自本轮首次模型调用开始的总时长，单位为毫秒 |

上限使用正整数；无效配置回退到默认值。
摘要、回复修复和重试均计入总量。
token 预留是保守上限，与供应商的实际计费数量不同。
单次传输超时仍由 `LLM_REQUEST_TIMEOUT_MS` 控制。
持久化、恢复及收紧配置的规则见[单轮模型调用预算](agent-durability.md#单轮模型调用预算)。

## 数据库管理

[schema.prisma](../../prisma/schema.prisma)定义当前数据结构。
数据库命令如下：

| 命令 | 用途 |
| --- | --- |
| `pnpm db:generate` | 生成与当前 schema 匹配的 Prisma Client。 |
| `pnpm db:push` | 将当前 schema 同步到配置的数据库。 |
| `pnpm db:seed` | 重建演示用户的业务数据，加载固定产品。 |
| `pnpm db:reset` | 删除配置的数据库，再重建表结构和初始模拟数据。 |
| `pnpm db:studio` | 打开 Prisma Studio 查看记录。 |

### 生成客户端

`pnpm db:generate` 执行 `prisma generate`。
Prisma 读取 `prisma/schema.prisma`。
生成器使用 `prisma-client`，输出到 `lib/db/generated`。
该目录由生成命令维护，不提交到 Git。
公共导入入口为 [lib/db/prisma.ts](../../lib/db/prisma.ts)。
普通代码从 `@/lib/db/prisma` 导入模型类型和运行时命名空间。
独立脚本使用相对路径导入。
业务代码通过客户端查询和写入数据库。
这个命令不创建表，也不写入业务数据。

离线环境中，Prisma CLI 会检查更新，命令可能长时间无输出。
执行 Prisma CLI 前，先设置以下环境变量：

```sh
CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 CI=1 pnpm db:generate
```

PowerShell 逐项设置后执行：

```powershell
$env:CHECKPOINT_DISABLE = '1'; $env:PRISMA_HIDE_UPDATE_MESSAGE = '1'; $env:CI = '1'; pnpm db:generate
```

Prisma CLI 读取 [prisma.config.ts](../../prisma.config.ts)。
该文件声明 schema、数据库地址和种子命令。
schema 只声明 SQLite 类型，地址由配置文件提供。
CLI 和运行时共用 [url.ts](../../lib/db/url.ts)。
相对 `file:` 路径以仓库的 `prisma/` 目录为基准。
因此，`file:./dev.db` 指向 `prisma/dev.db`。

SQLite 客户端使用连接级队列隔离并发请求。
事务提交或回滚前，普通查询等待。
事务内部须使用传入的事务句柄。
改用全局客户端会等待自身持有的连接锁。
隔离验证见 [database-adapter-isolation.test.ts](../../tests/integration/database-adapter-isolation.test.ts)。

### 同步表结构

`pnpm db:push` 执行 [db-push.ts](../../scripts/db-push.ts)。
脚本加载环境配置，再调用 `prisma db push`。
脚本同时固定 schema 引擎日志级别，无需手工设置，见 [prisma-cli-env.ts](../../lib/prisma-cli-env.ts)。
数据库地址来自 `DATABASE_URL`。
默认 SQLite 数据库为 `prisma/dev.db`。

Prisma 按 schema 创建或调整表、字段和约束。
数据库不存在时，Prisma 创建数据库。
`db:push` 不生成迁移历史文件。

警告：表结构变更可能删除字段或数据。
出现数据丢失提示时，先核对变更和备份。
普通同步不会填充模拟业务记录。

Prisma 7 的 `db push` 不再自动生成客户端。
修改 schema 或生成器后，单独执行 `pnpm db:generate`。
数据库同步与客户端生成是 2 个独立步骤。
规则见 [Prisma CLI 说明](https://docs.prisma.io/docs/cli/v7/db/push)。

### 填充模拟数据

`pnpm db:seed` 执行 [seed.ts](../../prisma/seed.ts)。
脚本写入演示用户、账户、联系人和业务记录。
脚本也写入固定理财产品。

警告：重复执行会删除并重建演示用户的业务记录。
删除范围包括账户、流水、持仓、卡片和联系人。
订阅、预算和定时任务也会重建。
固定理财产品会按预置 ID 重建。

脚本尝试写入数据库的 `.backup.db` 副本。
备份失败只记录警告，种子写入仍会继续。
需要保留操作记录时，先停止服务并自行备份。

`db:seed` 保留对话、运行和执行回执等历史记录。
业务记录重建后，旧对话可能仍指向原操作。
从初始状态重新体验时，使用 `db:reset`。

首次建立空库时，按“首次启动”依次执行 `db:generate`、`db:push` 和 `db:seed`。
日常启动只需 `pnpm dev`，无需重新填充数据。
修改 schema 后，同步表结构并更新客户端。

### 从初始状态重新体验

`pnpm db:reset` 删除整个配置数据库。
随后，命令重建当前表结构并执行 `db:seed`。
旧记录的删除范围如下：

- 对话、模型上下文和未提交的业务草稿。
- 待确认操作、验证码和失败计数。
- 运行、模型请求、工具调用和事件日志。
- 工作流、人工核对和执行回执。
- 操作审计、安全事件和业务数据。

重置后恢复初始模拟账户、余额、流水和定时任务。
“从初始状态”不表示余额为 0 或没有示例流水。
语言和开发者模式的浏览器设置继续保留。
`.env.local` 和模型密钥也继续保留。

警告：重置前保存需要保留的数据。
没有可用备份时，删除的记录无法恢复。
种子脚本的备份发生在数据库重建后。
该备份不能恢复重置前的记录。

在仓库根目录按以下步骤操作：

1. 停止 `pnpm dev` 或 `pnpm start`。
2. 停止 `pnpm agent:worker` 和外部定时调度。
3. 关闭 Prisma Studio 和其他数据库连接。
4. 核对应用使用的 `DATABASE_URL`。
5. 按需备份数据库，方法见下文。
6. 执行重置命令。

   ```sh
   pnpm db:reset
   ```

7. 启动应用。

   ```sh
   pnpm dev
   ```

8. 刷新所有已打开的浏览器页面。

所有进程都需停止后再重置。
旧进程可能持有已删除文件的连接或缓存。
只刷新页面不能替代重启进程。

数据库地址来自进程环境或 `.env.local`。
未设置 `DATABASE_URL` 时，默认使用 `prisma/dev.db`。
相对路径以 `prisma/` 为起点。
例如 `file:./dev.db` 指向 `prisma/dev.db`。
重置仅允许仓库内的 SQLite 文件。
路径检查见 [db-push.ts](../../scripts/db-push.ts)。

需要显式选择默认库时，重置和启动使用相同配置：

```sh
DATABASE_URL=file:./dev.db pnpm db:reset
DATABASE_URL=file:./dev.db pnpm dev
```

注意：设置自定义 `DATABASE_URL` 时，重置作用于自定义库。
若启动应用使用另一个地址，页面会继续显示另一个库的数据。

#### 备份默认数据库

停止所有数据库连接后，用备份脚本创建快照：

```sh
node scripts/db-backup.mjs
```

脚本把快照写入 `logs/db-backups/`。
文件名包含时间、随机标识和源数据库文件名。
执行后，脚本打印快照路径和源库路径。
快照目录不存在时自动创建，命令可以重复执行。
同一秒生成的快照各自保留，不覆盖旧快照。
源库不存在时，脚本提示先执行 `pnpm db:push`，并以非 0 状态退出。
快照保存在 `logs/` 下，已被 `.gitignore` 忽略，不提交。
快照使用 `node:sqlite`，配置加载依赖已安装的 `@next/env`。
同名 `.json` 文件记录源库、快照路径与恢复说明。

脚本使用 SQLite 在线备份，快照包含已提交的预写日志（WAL）数据。
只复制主数据库文件可能遗漏 WAL 中的提交。

备份与份额回填共用 `scripts/database-file.mjs`。
配置加载与 Prisma 命令一致，会读取 `.env.local`。
显式导出的 `DATABASE_URL` 优先，不打印凭据。
未设置时，脚本使用 `file:./dev.db`，即 `prisma/dev.db`。
备份自定义库时，先导出与启动应用相同的地址：

```sh
DATABASE_URL=file:./other.db node scripts/db-backup.mjs
```

相对 `file:` 路径以 `prisma/` 为基准。
备份成功后，再执行重置。

#### 只清空聊天记录

只需重新开始对话时，启用开发者模式。
然后使用 AI 助手中的“清空对话”。
该操作清空共享对话、模型上下文和业务草稿。
业务数据、操作审计、运行事件和执行回执继续保留。
未结束的 Agent 工作会阻止清空。
卡片页的独立待验证操作继续保留。
完整重置与清空对话的范围不同。

修改 schema 后，先生成客户端，再同步数据库。
之后才能启动应用或构建。
项目仅支持当前 schema 和接口契约。

修改金额字段前，先读[金融数值](financial-values.md)。
字段名称、单位和精度也约束种子数据及测试数据。

### 数据库备份与净值份额升级

理财持仓按“净值 + 份额”记账后，旧库需要补齐 `shares`。
以下步骤按顺序执行，顺序不能交换。

先备份数据库，命令与快照目录见[备份默认数据库](#备份默认数据库)：

```sh
node scripts/db-backup.mjs
```

再同步表结构：

```sh
pnpm db:push
```

同步新增净值和份额字段，不派生份额。
`db push` 不生成客户端，代码改动后仍需执行 `pnpm db:generate`。

产品净值或完整号码缺失时，先准备显式的模拟数据清单。
示例位于 `scripts/fixtures/demo-reference.example.json`。
该文件提供虚构的演示值，不是从脱敏号码恢复的数据。
复制示例到 `logs/`，逐条核对记录、归属与预期展示值。
未知或已变更的记录不得直接套用示例。

```sh
pnpm exec tsx scripts/demo-reference-backfill.ts --plan=logs/reference.json --dry-run
pnpm exec tsx scripts/demo-reference-backfill.ts --plan=logs/reference.json --apply
```

默认只预演，`--apply` 才写入。
清单只补空值，不覆盖已有净值或完整号码。
归属、名称、产品代码或展示值不匹配时整批回滚。
未列入清单的用户记录保持原值，账户余额与流水不变。

旧持仓按最新净值派生份额：

```sh
node scripts/investment-share-backfill.mjs
```

默认是只读试运行，不写入数据库。
试运行打印表格，列为 `holding`、`product`、`old market value`、`net value`、`shares`、`new market value`、`drift` 与 `outcome`。
逐行的 `outcome` 为 `derived`、`derived (cost basis)` 或 `skipped: <原因>`。
`derived (cost basis)` 表示 `estimatedMarketValue` 为空，市值回退为剩余持仓成本。
跳过原因只有 2 种：`no-net-value` 表示产品无净值或无匹配产品，`net-value-not-positive` 表示净值为 0。
存在跳过行时退出码为 `2`，表示升级尚未完成。
退出码 `0` 表示本次没有未解决行，`1` 表示执行失败。
表格之后打印汇总行，例如：

```text
[backfill] migrated: 2 (dry run)
[backfill] skipped (历史数据不足): 1
[backfill] total economic-value drift: 0.0000003265 CNY
[backfill] Re-run with --apply to persist the derived shares.
```

核对结果后写入：

```sh
node scripts/investment-share-backfill.mjs --apply
```

脚本只接受 `--apply` 1 个参数，其他参数报错。

派生口径为 `shares = FLOOR(市值 ÷ 净值, 6 位小数)`，市值取持仓的 `estimatedMarketValue`。
`estimatedMarketValue` 为空时，市值回退为剩余持仓成本。
`--apply` 在单个事务内写入 `shares`、`estimatedMarketValue` 和 `shares_estimated = 1`。
写入的市值是 `shares × 净值` 的精确乘积，与份额保持自洽。
漂移守卫：任一笔经济价值变化达到 `0.01 元` 时，脚本整轮不写入，并以非 0 状态退出。
净值为负时，脚本同样中止并保持零写入。

派生的份额是估算，不是申购记录。
读取侧因此报 `valueBasis: 'MIGRATED_ESTIMATE'`，页面、卡片和微信标注“估算”。
试运行和 `--apply` 都会说明这一标记。
净值、份额与收益口径见[理财净值、份额与收益口径](investments.md)。

产品没有净值时不伪造份额。
这类持仓保持原样，汇总中计为 `历史数据不足`。

脚本只处理 `status = 'HOLDING'` 且 `shares` 为空的持仓。
`REDEEMED` 持仓和已有份额的持仓不被修改。
重复执行不会再次派生，已迁移数量为 `0`。
汇总包含已迁移数量、跳过数量和总经济价值漂移。

需要回滚时，按以下步骤恢复：

1. 停止所有数据库连接。
2. 核对快照旁 `.json` 中的 `source`，确认恢复目标。
3. 保存或删除该目标的 `-wal` 与 `-shm` 旁文件。
4. 用快照覆盖目标数据库。
5. 恢复匹配的代码版本并执行 `pnpm db:generate`。

删除 `-wal` 与 `-shm` 的原因：避免重放旧预写日志。
POSIX shell 与 PowerShell 两种写法等价，只执行其一。

POSIX shell：

```sh
rm -f prisma/dev.db-wal prisma/dev.db-shm
cp 'logs/db-backups/<时间戳>-dev.db' prisma/dev.db
pnpm db:generate
```

PowerShell：

```powershell
Remove-Item -Force -ErrorAction SilentlyContinue prisma/dev.db-wal, prisma/dev.db-shm
Copy-Item 'logs/db-backups/<时间戳>-dev.db' prisma/dev.db
pnpm db:generate
```

恢复后按需执行 `pnpm db:seed`，或直接启动应用。

### 卡片结算账户补绑定

需要补齐未绑定结算账户的卡片时，按[卡片管理](card-management.md#数据升级与回滚)执行。
备份、同步、补绑定和回滚命令在该专题。

## 页面入口

| 路径 | 用途 |
| --- | --- |
| `/` | 默认跳转到 AI 助手。 |
| `/agent` | 对话，查看结果和工作流卡片。 |
| `/overview` | 查看资产总览。 |
| `/contacts` | 添加、查看和删除联系人。 |
| `/investments` | 查看理财产品及当前持仓。 |
| `/manual` | 开发者模式下演示银行后台核对，登记核对结论。 |
| `/runs` | 开发者模式下查看运行与工具调用状态，申请恢复。 |
| `/schedules` | 查看定时任务和提醒。 |
| `/cards` | 查看卡片；在页面确认并验证后添加或删除模拟卡片。 |
| `/bills`、`/subscriptions` | 查看账单和订阅。 |
| `/activity` | 查看面向用户的操作记录和业务摘要。 |
| `/audit` | 开发者模式下查看完整操作审计和工具详情。 |
| `/security` | 查看安全事件；开发者模式可重置失败计数。 |

HTTP 请求使用服务端配置的固定演示用户。
Agent 发起的确认、验证码和恢复入口显示在对话卡片中。
卡片增删使用卡片页的独立确认和验证流程。
Agent 不能新增、申请或删除卡片。
联系人保存表单和删除确认框代表用户的明确确认。
联系人变更与操作审计在同一事务中提交。
完整手机号用于收款人查询，页面和接口返回脱敏手机号。
客户端 Cookie 和身份参数不能切换用户或会话。
当前没有登录系统，模拟身份不等同于真实银行认证。
身份与授权规则见[安全设计](security.md)。

桌面导航按助手与任务、银行业务、记录与安全分组。
手机使用可关闭的侧边抽屉。
选择聊天建议只填入草稿，不直接发送。
Enter 发送消息，Shift + Enter 换行。
输入法确认候选字时，Enter 不发送消息。
输入框随可用视口高度调整。
页面打开时恢复共享对话和待确认操作。
正常使用会持续保存对话；刷新页面不会清空记录。
聊天页首次读取最近 20 条消息。
“加载更早的消息”每次补入前 20 条。
显示分页不裁剪数据库中的完整对话。
同一会话的并发请求受执行租约保护。
另一个页面正在执行时，新请求会提示冲突。

用户输入按纯文本显示，助手正文支持 Markdown。
表格、列表、引用、代码块和链接使用统一渲染组件。
原始 HTML 和远程图片不会执行或自动加载。
工具调用按查询、支付、卡片、理财和任务分组。
执行中的调用显示进度，完成后显示已记录的摘要。
输入框上方只显示当前请求的调用。
确认、取消或执行结束后，原消息中的调用同步更新。
刷新页面时，调用状态按运行记录和操作记录恢复。
已执行的卡片不再显示“需要确认”。
原始工具名、调用标识和脱敏参数仅在开发者模式展示。
卡片映射和展示规则见[对话业务卡片](chat-presentation.md)。

侧边栏底部有“开发者模式”开关，默认停用。
启用后显示“运行记录”和“操作审计”等开发入口。
AI 助手同时显示“刷新对话”和“清空对话”。
安全中心同时显示“重置失败计数”按钮。
按钮无需验证码，不会执行待办银行操作。
“刷新对话”重新读取已保存记录，不提交银行业务。
“清空对话”需确认，会清空共享对话和模型上下文。
银行数据、操作审计、运行事件和执行凭证仍保留。
待确认、执行中、待核对或未结束的工作会阻止清空。
清空与新请求使用同一会话写入检查，拒绝过时请求。
清空后，旧计划不会因浏览器缓存重新出现在聊天中。
开发者模式只控制演示工具，不提供身份认证。

### 历史消息接口

`GET /api/chat/history` 返回最近 20 条消息。
继续读取时，传入上一次响应的 `nextCursor`。
`limit` 默认为 20，允许 1 至 20 条。
接口按原顺序返回消息，单条回复和卡片保持完整。
`hasMore` 表示还有更早的消息。

分页标识绑定所属用户、会话和历史版本。
消息标识确定读取位置，时间戳不承担去重职责。
新消息追加不会改变原分页位置。
开发者清空对话会更换历史版本。
旧版本或丢失位置的分页请求返回 `409 CONFLICT`。
格式错误的分页请求返回 `400 VALIDATION`。
响应中的 `revision` 和 `historyGeneration` 用于前端隔离旧响应。

服务端读取完整会话，再补充授权和工作流状态。
当前会话仍以 JSON 保存，服务端需解析完整归档。
页面和接口只传输所选页的消息。
分页读取不会修改原始对话或模型消息。
代码入口见[历史读取模型](../../app/agent/history.ts)。

`search_conversation_history` 从原始对话归档查找文字。
该绿色查询限定运行所属用户和会话。
查询每次最多返回 20 条用户或助手原话。
传入 `beforeIndex` 时，只读取该位置之前的记录。
代码入口见[归档查询](../../agent/conversation-history-search.ts)。
模型请求的压缩配置见[上下文压缩](context-compaction.md)。

普通 HTTP 页面可能没有 `crypto.randomUUID()`。
前端会使用 `crypto.getRandomValues()` 生成请求标识。
请求标识只负责运行接收去重。
银行操作的授权和幂等键仍由服务端控制。

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
驱动真实对话轮的用例，把 [tests/helpers/timeouts.ts](../../tests/helpers/timeouts.ts) 的 `CHAT_DRIVEN_TEST_TIMEOUT_MS` 作为 `it(...)` 的第 3 个参数。
用命令行初始化冷库的用例传 `COLD_DB_PROVISION_TEST_TIMEOUT_MS`。
两者是共享常量，不得写成裸数字，也不得在用例里另建副本。

定向测试命令如下：

```sh
pnpm exec vitest run tests/unit/financial-values.test.ts
pnpm test:watch
```

浏览器验收独立于 Vitest：

```sh
LLM_MODE=mock pnpm exec tsx tests/e2e/acceptance.e2e.ts
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

离线验收使用 `prisma/e2e.db`。
在线验收使用 `prisma/live-acceptance.db`。
验收脚本准备模拟数据，并启动开发服务器。
`E2E_BROWSER_PATH` 可指定浏览器可执行文件。

离线脚本显式设置 `LLM_MODE=mock`。
脚本同时选择 `faux` 服务商和模型。
服务启动后，脚本查询 `/api/health`。
只有响应中的 `data.llmMode` 为 `mock`，才继续验收。
模式不符时，验收失败并停止。
仅有离线脚本名称或服务启动日志不能证明实际模式。
单独运行演示服务时，也可查看 `/api/health` 核对模式。
在线脚本显式使用 `live`，结果应按在线验收记录。

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

## 文件日志

命令默认把输出写到终端。
需要保留文件时，将输出保存到 `logs/`。
文件日志位置的项目规则见[仓库上下文](../../CONTEXT.md)。

先创建目录，再执行需要记录的命令：

```sh
mkdir -p logs
pnpm test > logs/tests.log 2>&1
pnpm build > logs/build.log 2>&1
```

`>` 保存标准输出，`2>&1` 合并错误输出。
这个写法会覆盖同名日志。
需要追加记录时，将 `>` 换成 `>>`。

日志可能包含请求和错误信息，不提交到 Git。
`.gitignore` 已忽略 `logs/` 和 `.log` 文件。
业务审计、事件和执行回执仍保存在数据库。
