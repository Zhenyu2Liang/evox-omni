# 测试约定

## 测试层次

| 目录 | 范围 |
| --- | --- |
| `unit/` | 策略、参数、金额、执行器与展示状态 |
| `scenarios/` | 演示场景与离线模型场景 |
| `app/` | 进程内真实路由与 SSE 集成 |
| `integration/` | 执行、授权、回执、审计与恢复 |
| `helpers/` | 隔离数据库、夹具与模型脚本 |
| `e2e/` | 独立的真实浏览器验收 |

根 `vitest.config.ts` 收集 `tests/` 与 `agent/` 下的测试。
默认使用 mock 模式，不调用真实模型。
浏览器入口不由 Vitest 收集。
真实模型验收使用独立 live 入口。

## 数据与执行

`setup.ts` 固定使用 `prisma/test.db`。
它检查生成客户端，并按结构哈希准备测试库。
准备失败会抛出完整诊断。
夹具由测试通过 `resetDatabase` 等入口加载。

共享 SQLite 测试必须顺序执行。
不得同时启动多个会重置同一测试库的进程。
浏览器与部署测试也必须单独运行。
隔离库名称与行为见各子目录说明。
不得把开发库或用户备份用于测试重置。

熔断状态按所有者持久化。
同一用户的新会话不能隔离该用户的锁。
需要隔离时重置夹具或创建独立用户。
仅数据库无关测试可使用 `VITEST_SKIP_DB_SETUP=1`。

## 常用命令

`pnpm test` 运行全部 Vitest 测试。
`pnpm exec vitest run tests/unit` 运行指定目录。
`pnpm typecheck` 检查类型。
`pnpm exec tsx tests/e2e/acceptance.e2e.ts` 运行浏览器验收。

## 面板声称的回归覆盖

确认/MFA 面板只在安全网关从真实工具调用持久化 `PendingAction` 后出现；模型散文不创建面板。
`unit/agent`（`write-continuation*.test.ts`、`system-prompt.test.ts`）与 `integration/write-continuation.test.ts` 覆盖「声明写操作却只用散文声称面板/等待确认、未发出工具调用」的场景：服务端做一次有界续接，仍无写入时以服务端叙述发布真实未提交状态，伪造声称绝不进入会话记录。
同一覆盖断言「参数齐全→续接后真实发起（打开真实网关闸门）或被网关拦截」以及「信息不足→正常澄清，不消耗续接预算」。
`e2e/live-acceptance.e2e.ts` 只对该情形做诊断（`noCardDiagnostics`）与催促，不证明真实模型稳定性（`e2e/**` 由另一工作流负责）。
`unit/planner/mock-amount-clarification.test.ts` 与 `app/nl-entry-http.test.ts` 覆盖「信息不足→澄清，不产生工具调用」。
细节见各子目录 CONTEXT.md。

## 证据范围

原始 Pi 场景与生产运行入口必须区分。
测试模型输出不证明真实模型的稳定性。
路由处理器测试不证明浏览器渲染或点击行为。
业务断言必须核对余额、流水、状态与审计。
展示断言必须区分模型原文与服务端金融结果。

不得将历史通过数量写成当前验证结果。
不得删除断言或跳过失败来宣称通过。

完整测试方法见
[test-cases.md](../docs/cn/test-cases.md)。
