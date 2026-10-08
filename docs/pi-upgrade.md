# Pi 1.1 升级说明

本分支将 Pi 从 `@mariozechner/pi-agent-core` / `pi-ai` 0.73.1 迁移到官方新包名
`@earendil-works/pi-agent-core` / `pi-ai`，两个依赖均锁定为 **1.1.0**。
旧包名的 npm latest 仍停在 0.73.1；本次按官方仓库的新包名升级。

官方来源：[v1.1.0 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.1.0)、
[Agent 包](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/package.json)、
[AI 包](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/package.json)。

## 接入变更

- Node.js 最低版本改为 **22.19.0**，已同步 package.json 和 README。
- Agent 必须显式接收 `streamFn`。`resolveProvider()` 返回 `{ model, streamFn }`，
  构造 Agent 时同时传入；`resolveModel()` 保留为模型检查接口。
- live 使用 `builtinModels()` 集合和原生服务商适配器；mock 为每个 runtime
  创建独立 `fauxProvider()` 和 `createModels()` 集合。未使用临时 `/compat` 接口。
- `deepseek-flash` 在 1.1.0 中直接注册，使用 DeepSeek 自有地址，无需改写模型名。
  自定义服务商仍须明确配置地址，并使用独立的 `<PROVIDER>_API_KEY`。
- 工具 schema、事件和状态类型迁移到新包；工具参数及结果在 Pi 边界转换为 JSON。
  确认续接仍替换原工具调用对应的结果，保留正确的 `tool_calls` / `tool` 顺序。
- 独立动作续接按服务端动作的工具名匹配，DAG 节点续接匹配外层 `submit_plan`；
  同一调用 id 在不同轮次重用时选择最新匹配项。
  若重启丢失了原始调用快照，只报告结果播报失败，保留已入账事实和原查询记录。
- 更新 Next.js 外部依赖配置和测试辅助 Agent。live resolver 测试迁入根测试目录，
  不再需要单独的 Vitest 配置。

银行 SDK 仍是模拟环境。原有权限网关、确认/MFA 和交易幂等逻辑继续使用同一条执行链路。
API Key 保留在忽略提交的 `.env.local`，未加入模型对象或会话快照。

## 安装和启动

```bash
npm ci
npm run db:generate
npm run db:push
# 仅首次建立演示数据时运行；已有数据无需重新 seed
npm run db:seed
npm run dev
```

保留原有 `.env.local` 即可使用 live 配置；无需更换 DeepSeek Key 或模型名。
数据库结构没有因 Pi 升级而变更，无需重置已有库。

## 验证

```bash
npm run typecheck
npm run test
npm run build
npx tsx tests/e2e/acceptance.e2e.ts
npx tsx tests/e2e/live-acceptance.e2e.ts
```

构建需要按项目原有流程准备数据库；本次构建使用独立验证库。
浏览器脚本分别使用 `e2e.db` 和 `live-acceptance.db`，不会重置 `dev.db`。
live 浏览器验收会调用真实模型 API，需本地配置 Key。

离线适配器回归另外验证：独立 mock runtime 不联网；原生 DeepSeek 适配器正确
序列化确认续接；自定义服务商的地址与鉴权正确。该层注入 fake fetch 和测试 Key。

本次最终验证（本机 Node 25.9.0 / Chrome）：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npm run test` | 107 文件 / 752 用例通过 |
| `npm run build` | 通过，使用独立验证库 |
| mock 浏览器验收 | 7 PASS / 0 FAIL / 0 SKIP |
| live 最终定向复验（`LIVE_SCENARIOS=3,6`） | 2 PASS / 0 FAIL / 0 SKIP |

升级后曾运行完整 live 验收，8 项通过；随后补强续接匹配，最终针对小数转账和同会话
四轮对话复验（含转账确认、MFA、额度查询），未再出现工具消息配对 400。
“重启丢失原调用”另外由真实网关/DB 集成测试覆盖：只入账一次，保留原联系人查询结果，
明确报告播报失败。以上仅为本地演示验证，不代表多实例或真实银行接入验证。

验证前后 `prisma/dev.db` 的 SHA-256 一致，`.env.local` 未修改。
