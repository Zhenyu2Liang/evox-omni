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
