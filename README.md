# 融序 RONGXU · EvoX

融万象之需，序金融之事。

银行智能体比赛演示项目。
系统把自然语言请求转成可检查的银行操作。
技术栈为 Next.js 16、TypeScript 7、Pi 1.2 和 Prisma 7/SQLite。

项目使用模拟账户和身份验证。
打开页面直接进入固定用户的共享对话，无需登录。
不同浏览器共享已保存的记录，界面默认中文并支持英文。
正常聊天持续保存；开发者模式提供运行记录和对话清空工具。
项目未接入真实银行或支付服务。

## 功能

- 按联系人、姓名或手机号转账。
- 消费分析、异常交易识别和理财申购、赎回。
- 卡片查询与控制、页面验证后的卡片增删、订阅管理和定时提醒。
- 联系人添加、删除，以及理财产品和持仓展示。
- 多步工作流的暂停、恢复、取消和人工接管。
- 事件日志、执行回执和崩溃恢复。
- 完整对话归档、历史分页和 Pi 官方上下文压缩。
- 微信文字对话、显式操作确认与验证，复用银行安全网关。

## 首次运行

使用 Node.js 22.19 及以上版本和 pnpm 12.3.4。
版本要求来自 [package.json](package.json)。
依赖版本、TypeScript 工具适配和数据库生成规则见[开发指南](docs/cn/development.md#依赖版本与升级)。

首次建立模拟数据时，执行以下命令：

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

打开[应用首页](http://localhost:3000)，默认进入 AI 助手。
默认 `mock` 模式无需密钥或网络。
模拟验证码为 `123456`。

首次进入 AI 助手会显示使用引导，介绍功能、示例和确认规则。
关闭后不再自动弹出，可从标题栏的“使用帮助”重新打开。
示例只填入输入框，修改后再发送，不会自动办理业务。
关闭状态保存在当前浏览器；清除浏览器数据或更换访问地址后会重新显示。

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
| `pnpm weixin:login` / `pnpm weixin:start` | 扫码登录并启动微信通道 |
| `pnpm weixin:status` / `pnpm weixin:logout` | 查看登录缓存或清除本地微信绑定 |

## 文档

开发说明统一放在 [docs/cn](docs/cn/README.md)。

- [开发指南](docs/cn/development.md)：安装、配置和运行。
- [已实现功能说明](docs/cn/implemented-features.md)：业务能力、使用入口和竞赛场景覆盖。
- [架构设计](docs/cn/architecture.md)：模块职责和执行流程。
- [持久化与恢复](docs/cn/agent-durability.md)：事件、重试和恢复。
- [上下文压缩](docs/cn/context-compaction.md)：Pi 官方接口、归档和依赖代价。
- [微信通道](docs/cn/weixin.md)：扫码、对话、确认命令和测试边界。
- [金融数值与结算](docs/cn/financial-values.md)：单位、精度和结算。
- [安全设计](docs/cn/security.md)与[当前限制](docs/cn/known-risks.md)：权限和模拟边界。

比赛要求见 [req.md](req.md)。
