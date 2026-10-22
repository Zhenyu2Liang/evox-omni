# 命令入口

## 职责

脚本加载运行配置，调用项目模块并设置退出码。
独立脚本使用相对路径导入。

| 脚本 | 命令与作用 |
| --- | --- |
| `db-push.ts` | `pnpm db:push` 同步当前结构 |
| `agent-recovery.ts` | `pnpm agent:recover` 单次恢复，`pnpm agent:worker` 持续扫描 |
| `scheduler.ts` | `pnpm scheduler:tick` 检查已到期任务 |
| `weixin.ts` | `pnpm weixin:login/start/status/logout` 管理微信通道 |
| `card-account-binding.ts` | 为 `linkedAccountId` 为空的借记类卡片补绑结算活期账户，支持 `--dry-run` 与 `--rollback=<文件>` |

## 数据库命令

`db-push.ts` 通过项目本地 Prisma 命令执行。
命令环境复用 `lib/prisma-cli-env.ts`。
配置加载使用 Next.js 环境加载器。

显式 `--force-reset` 会删除目标库及其旁文件。
删除目标必须在当前工作区内。
该命令不转换旧数据库格式。

安装、生成客户端和数据库操作顺序见
[development.md](../docs/cn/development.md)。
当前数据库页面按请求读取数据。
生产构建前不必对开发库播种。
运行应用读取业务数据前，目标库仍需准备完成。

## 恢复与调度

恢复命令支持 `--once`、`--interval-ms` 与 `--limit`。
恢复策略由持久化身份、租约与回执决定。
脚本参数不能替代业务授权。

调度命令单次检查任务，默认使用真实时间。
`--now` 接受用于检查的 ISO 时间。
脚本仅扫描已绑定会话的到期任务。
启动 Web 服务不会自动循环执行该脚本。
到期金融任务仍需确认和验证。
详情见 [scheduled-tasks.md](../docs/cn/scheduled-tasks.md)。

## 卡片补绑定

`card-account-binding.ts` 一次性补齐 `linkedAccountId` 为空的历史卡片。
脚本只读 `linkedAccountId` 标量列与 `prisma.account.findMany`，不依赖卡片与账户的 relation 字段。
候选仅限 `type` 为 `DEBIT` 或 `VIRTUAL` 的卡片，`CREDIT` 卡片按 `credit-card` 跳过。
不经 `package.json` 调用：`pnpm tsx scripts/card-account-binding.ts`。

唯一启发式是「同 `userId` 名下恰好一个 `CHECKING` 账户」。
恰好一个才补绑，零个跳过 `no-checking-account`，多个跳过 `ambiguous-checking-accounts`。
`SAVINGS` 账户不进入候选，脚本不猜测绑定目标。
写入前按 id 重读账户，校验存在、同用户与 `CHECKING` 类型，失败跳过 `unowned-account`。

写入使用 CAS：`where` 含 `linkedAccountId: null`。
`count` 为 0 视为已被其他写入占用，计 `already-bound`，不是错误。
重复执行因此幂等：已绑定卡片不再进入候选，补绑数为 0 时退出码仍为 0。

`--dry-run` 只打印计划，不写库，也不生成回滚文件。
真跑把变更清单写到 `logs/card-account-binding/<时间戳>-applied.json`。
`--rollback=<文件>` 只还原当前值仍等于脚本写入值的行，不覆盖之后的人工改动。
参数错误、回滚文件非法与数据库不可用都以非 0 退出码结束。
汇总只输出库中已脱敏的 `Account.number`，不输出完整账号、卡号或配置值。
