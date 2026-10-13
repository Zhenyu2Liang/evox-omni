# AI Banking Agent

银行智能体比赛演示项目。
系统把自然语言请求转成可检查的银行操作。
技术栈为 Next.js、TypeScript、Pi Core 和 Prisma/SQLite。

项目使用模拟账户和身份验证。
项目未接入真实银行或支付服务。

## 功能

- 按联系人、姓名或手机号转账。
- 消费分析、异常交易识别和理财申购、赎回。
- 卡片控制、订阅管理和定时提醒。
- 多步工作流的暂停、恢复、取消和人工接管。
- 事件日志、执行回执和崩溃恢复。

## 首次运行

使用 Node.js 22.19 及以上版本和 pnpm 12.3.4。
版本要求来自 [package.json](package.json)。

首次建立模拟数据时，执行以下命令：

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

打开[对话页面](http://localhost:3000/agent)。
默认 `mock` 模式无需密钥或网络。
模拟验证码为 `123456`。

警告：再次执行 `pnpm db:seed` 会重建演示数据。
数据库操作与 DeepSeek 配置见[开发指南](docs/cn/development.md)。
真实模型密钥保存在 `.env.local`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动开发服务 |
| `pnpm typecheck` | 检查 TypeScript 类型 |
| `pnpm lint` | 检查代码规范 |
| `pnpm test` | 运行离线测试 |
| `pnpm build` / `pnpm start` | 构建并启动生产服务 |
| `pnpm db:studio` | 查看本地数据库 |
| `pnpm db:reset` | 删除模拟数据库并重建数据；执行前停止服务 |
| `pnpm scheduler:tick` | 检查到期定时任务 |
| `pnpm agent:recover` | 恢复一批中断运行 |
| `pnpm agent:worker` | 启动常驻恢复服务 |

## 文档

开发说明统一放在 [docs/cn](docs/cn/README.md)。

- [开发指南](docs/cn/development.md)：安装、配置和运行。
- [架构设计](docs/cn/architecture.md)：模块职责和执行流程。
- [持久化与恢复](docs/cn/agent-durability.md)：事件、重试和恢复。
- [金融数值与结算](docs/cn/financial-values.md)：单位、精度和结算。
- [安全设计](docs/cn/security.md)与[当前限制](docs/cn/known-risks.md)：权限和模拟边界。

比赛要求见 [req.md](req.md)。
