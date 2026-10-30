<h1 align="center">
  <a href="https://github.com/Zhenyu2Liang/evox-omni">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/evox_brand_light.svg">
      <source media="(prefers-color-scheme: light)" srcset="docs/images/evox_brand_dark.svg">
      <img src="docs/images/evox_brand_dark.svg" alt="EvoX Logo" width="420" height="140">
    </picture>
  </a>
</h1>

<h2 align="center">万象柜坊 · EvoX Omni</h2>

<p align="center"><a href="README.md">English</a> | <strong>简体中文</strong></p>

<p align="center">通过自然语言办理模拟银行业务的 AI 智能体，支持 Web 和微信文字对话。</p>

<div align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache--2.0-blue?style=for-the-badge" alt="Apache-2.0 License">
  </a>
  <a href="docs/cn/README.md">
    <img src="https://img.shields.io/badge/docs-Documentation-2E8B57?style=for-the-badge&amp;logo=readthedocs" alt="开发文档">
  </a>
  <a href="https://github.com/Zhenyu2Liang/evox-omni/issues">
    <img src="https://img.shields.io/badge/GitHub-Issues-5865F2?style=for-the-badge&amp;logo=github" alt="问题反馈">
  </a>
</div>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#功能">功能</a> ·
  <a href="#模型配置">模型配置</a> ·
  <a href="#微信接入">微信接入</a> ·
  <a href="docs/cn/README.md">开发文档</a>
</p>

从余额查询、账单分析到转账和卡片控制，操作经过服务端授权，并保存执行回执。

项目用于学习、研究和业务流程演示，未接入真实银行或支付服务。
账户、交易和验证码均为模拟服务。
当前使用免登录的固定演示用户，不同浏览器共享同一账户及对话记录。
生产部署所需的用户登录、角色分权和真实身份认证尚未提供。

## 功能

| 能力 | 支持内容 |
| --- | --- |
| 自然语言交互 | Web 流式对话、微信文字私聊、业务卡片与操作确认 |
| 账户与转账 | 账户余额、交易流水、联系人查询与按姓名或手机号转账 |
| 账单分析 | 消费分类、趋势、可疑交易识别及规则说明 |
| 月度与年度报告 | 页面查看、按需生成模型分析，导出 PDF、HTML 和 CSV |
| 卡片与订阅 | 卡片状态、消费限额、冻结与挂失、虚拟卡及订阅代扣管理 |
| 理财 | 产品比较、持仓与净值展示、申购、按份额或金额赎回 |
| 多步与定时任务 | 顺序和条件执行、暂停与恢复、定时提醒和到期付款确认 |
| 执行与恢复 | 操作审计、幂等执行回执、事件持久化与中断恢复 |

界面支持中文、英文，以及浅色、深色和跟随系统的外观设置。
对话持续保存，历史记录可分页查看；模型上下文压缩后仍保留完整归档。
功能入口和模拟边界见[已实现功能说明](docs/cn/implemented-features.md)。

## 快速开始

### 1. 准备环境

| 工具 | 版本要求 |
| --- | --- |
| Node.js | `>=22.19.0` |
| pnpm | `12.3.4` |
| Git | 用于克隆仓库 |

版本声明以 [package.json](package.json) 为准。
尚未安装指定 pnpm 版本时，可执行 `npm install --global pnpm@12.3.4`。

```sh
git clone https://github.com/Zhenyu2Liang/evox-omni.git
cd evox-omni
pnpm install --frozen-lockfile
```

### 2. 配置本地演示

在仓库根目录新建 `.env.local`。快速开始默认使用 `live` 模式，需要填写自己的 API Key。以下以 DeepSeek 为例：

```dotenv
DATABASE_URL=file:./dev.db
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
DEEPSEEK_API_KEY=<your-api-key>
```

此配置使用 `prisma/dev.db` 保存数据。
启动前，将 `<your-api-key>` 替换为自己的 DeepSeek API Key。`live` 模式需要网络连接，并可能产生模型服务费用。
离线演示可设置 `LLM_MODE=mock`。此模式使用脚本模型，自然语言解析范围有限，不需要 API Key，也不调用外部模型服务。
完整变量模板见 [.env.example](.env.example)。

### 3. 初始化并启动

以下初始化命令用于首次建立演示数据库：

```sh
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)，首页进入智能助手。
首次打开会显示使用引导，也可通过页面上的“使用帮助”再次查看。

**数据重置提示：**再次执行 `pnpm db:seed` 会重建演示用户的数据。
`pnpm db:reset` 会删除所选数据库并重新初始化；需保留数据时，先停止服务并[备份数据库](docs/cn/development.md#备份默认数据库)。

### 4. 体验业务

可在助手中尝试以下请求：

```text
查询我的账户余额。
分析 2026 年 9 月的消费。
检查可疑交易，并说明触发规则的原因。
给妈妈转账 300 元，备注“打车”。
明天下午 3 点给妈妈转账 300 元。
```

涉及确认或验证时，先核对收款人、金额、卡片和执行时间，再按页面提示继续。
演示验证码为 `123456`，不会发送真实短信。
月报和年报通过[账单报告页](http://localhost:3000/bills/reports)查看与导出。
报告模型分析需要主动点击生成；`live` 模式下会调用所配置的模型服务。

## 模型配置

在 `.env.local` 中配置服务商、精确模型标识和密钥，再重启银行服务。
以项目已适配的 DeepSeek 配置为例：

```dotenv
DATABASE_URL=file:./dev.db
LLM_MODE=live
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
DEEPSEEK_API_KEY=<your-api-key>
```

将 `<your-api-key>` 替换为实际密钥。
`live` 模式需要网络连接，并可能产生模型服务费用。
其他服务商、兼容接口地址及调用预算见[模型与环境配置](docs/cn/development.md#模型与环境配置)。
密钥仅保存在本地配置中，不提交到 Git，也不写入问题描述或运行日志。

## 微信接入

先启动银行 Web 服务，再在另一个终端执行：

```sh
pnpm weixin:login
pnpm weixin:start
```

使用微信扫码并完成绑定后，可通过文字私聊查询或提出业务请求。
微信与 Web 共用银行服务及演示数据。

| 命令 | 作用 |
| --- | --- |
| `/帮助` | 查看支持的需求和命令 |
| `/待办` | 查看当前操作及剩余待办数量 |
| `/确认` | 确认当前显示的这一笔操作 |
| `/验证 123456` | 为当前已确认的操作提交演示验证码 |
| `/取消` | 取消当前显示的这一笔操作 |

多笔操作逐笔展示，每笔分别确认；需要验证码时停留在当前步骤。
通道只接收扫码绑定用户的文字私聊。
登录缓存、连接配置、任务命令和恢复方式见[微信通道](docs/cn/weixin.md)。

## 架构与技术栈

技术栈为 Next.js、React、TypeScript、Pi Agent、Prisma 和 SQLite。
依赖固定版本由 `pnpm-lock.yaml` 管理。

请求通过 Web 或微信进入银行 HTTP 接口。
Pi 运行时组织工具调用和多步任务，安全网关检查身份、参数及权限。
需要授权的操作等待用户确认或验证，再由银行 SDK 写入数据库。
模型文字不能直接作为付款成功或身份验证通过的依据。

```text
app/              Web 页面与 HTTP 接口
components/       对话卡片、图表与业务界面
channels/weixin/  微信收发、逐笔确认与验证
agent/            Pi 运行时、银行工具与对话持久化
planner/          多步任务编排
security/         权限、验证、限额与安全网关
banking-sdk/      模拟银行业务与精确金额运算
lib/              共享契约、数据库访问与国际化
prisma/           数据模型与演示种子
tests/            单元、集成、场景与浏览器验收
docs/en/          英文开发与使用文档
docs/cn/          中文开发与使用文档
```

已入账金额以整数分保存，估值与比率使用精确十进制运算。
业务变更、审计和原执行回执在同一事务中提交。
机制与边界见[架构设计](docs/cn/architecture.md)、[安全设计](docs/cn/security.md)和[金融数值与结算](docs/cn/financial-values.md)。

## 开发与运行

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发服务 |
| `pnpm typecheck` | 检查 TypeScript 类型 |
| `pnpm lint` | 检查代码规范 |
| `pnpm test` | 运行离线测试 |
| `pnpm build` | 构建生产版本 |
| `pnpm start` | 启动已构建的版本 |
| `pnpm db:studio` | 查看本地数据库 |
| `pnpm scheduler:tick` | 检查到期任务并生成提醒或待确认操作 |
| `pnpm agent:recover` | 恢复一批中断运行 |
| `pnpm agent:worker` | 启动常驻恢复服务 |

Web 服务不内置常驻定时调度；定时检查需要单独配置[调度入口](docs/cn/scheduled-tasks.md#部署入口)。
到期付款仍需确认和验证。

测试使用隔离数据库。
数据库测试共享 `prisma/test.db`，同一仓库内不要同时启动多个数据库测试进程。
浏览器验收还需要可用的 Chrome 或 Chromium，配置见[测试指南](docs/cn/test-cases.md)。
从其他域名或反向代理访问时，需要配置[可信访问地址](docs/cn/development.md#可信访问地址)。
当前默认身份和演示认证不适用于真实金融业务或面向公众的生产部署。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 安装、环境配置、数据库备份与故障排查 | [开发指南](docs/cn/development.md) |
| 业务能力与使用入口 | [已实现功能](docs/cn/implemented-features.md) |
| 月报、年报、导出与模型分析 | [账单报告](docs/cn/bill-reports.md) |
| 微信登录、命令与权限 | [微信通道](docs/cn/weixin.md) |
| 事件、重试与崩溃恢复 | [持久化与恢复](docs/cn/agent-durability.md) |
| 对话归档与模型上下文压缩 | [上下文压缩](docs/cn/context-compaction.md) |
| 权限与模拟边界 | [安全设计](docs/cn/security.md)、[当前限制](docs/cn/known-risks.md) |
| 验证方法与证据范围 | [测试指南](docs/cn/test-cases.md) |

完整索引见[开发文档](docs/cn/README.md)，竞赛背景见[赛题要求](req.md)。

## 参与贡献

通过 [Issues](https://github.com/Zhenyu2Liang/evox-omni/issues) 反馈问题或讨论改动。
问题报告需包含提交版本、`mock` 或 `live` 模式、复现步骤及脱敏后的错误信息。
提交前移除 API 密钥、微信令牌和个人数据。

提交 Pull Request 时：

1. 说明解决的问题和行为变化。
2. 为业务与权限变更补充回归测试，并更新对应文档。
3. 依次完成 `pnpm typecheck`、`pnpm lint`、`pnpm test` 和 `pnpm build`。
4. 保留锁文件，不提交数据库、`.env.local`、登录状态或生成的 `output/`、`logs/` 文件。

## 许可证

项目原创代码采用 [Apache License 2.0](LICENSE)，版权声明见 [NOTICE](NOTICE)。
第三方依赖和仓库内已有独立许可的文件继续适用各自的许可证。

- [STC 文字规则与词表](.agents/skills/stc/LICENSE)采用 CC BY 4.0，代码采用其 [MIT 许可证](.agents/skills/stc/LICENSE-CODE)。
- 品牌标识来源见[品牌资源说明](public/brand/README.md)；项目许可证不授予第三方商标或品牌标识的使用权。
