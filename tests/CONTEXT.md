# 测试约定

## 目录与范围

| 目录 | 范围 |
| --- | --- |
| `unit/` | 策略、参数、金额、执行器与展示状态；安全、SDK 与执行权用例使用真实 SQLite |
| `scenarios/` | 编号演示场景 `test-01`…`test-17` 与离线模型场景 |
| `app/` | 进程内真实路由与 SSE 集成 |
| `integration/` | 执行、授权、回执、审计与恢复 |
| `helpers/` | 隔离数据库、夹具、模型脚本与进程恢复探针 |
| `e2e/` | 独立入口的真实浏览器验收与 HTTP 边界用例 |
| `fixtures/` | 共享的 `*.zh-CN.json` 对话与策略剧本，无本地 CONTEXT.md |

本目录根部的 `setup.ts` 准备测试库，`deploy-db-push.test.ts` 覆盖 `scripts/db-push.ts` 的冷库自建。

根 `vitest.config.ts` 收集 `tests/**/*.{test,spec}.ts` 与 `agent/**/*.{test,spec}.ts`。
`.e2e.ts` 与 `.e2e-helper.ts` 不匹配该 include，`pnpm test` 不会运行它们。
浏览器与边界入口一律用 `pnpm exec tsx <入口>` 单独运行。
默认使用 mock 模式，不调用真实模型。

## 入口

| 入口 | 内容 |
| --- | --- |
| `e2e/acceptance.e2e.ts` | mock 模型的真实浏览器验收，场景在 `JOURNEYS`，用 `E2E_JOURNEYS` 选择 |
| `e2e/live-acceptance.e2e.ts` | 真实模型的真实浏览器验收，场景在 `SCENARIOS`，用 `LIVE_SCENARIOS` 选择 |
| `e2e/date-tamper-boundary.e2e.ts` | 消费入账时间的纯 HTTP 边界用例，无模型、无浏览器 |

`SCENARIOS` 的 id 为 `15,14,13,12,11,10,9,8,0,1,2,2p,3,5,6,4,lA,lB,lC,lD,lE`。
`lA` 补办信用卡、`lB` 理财部分赎回、`lC`…`lE` 虚拟卡场景；选择 `2` 会同时选中 `2p`，场景 `7` 恒为最后阶段。
`e2e/helpers.ts` 与 `*.e2e-helper.ts` 是入口共用的驱动与断言模块，自身不运行。
入口细节见 [e2e/CONTEXT.md](e2e/CONTEXT.md)。

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

## 编写测试的不变量

消费入账时间由服务端拥有：`POST /api/cards/[id]/consume` 与 `consume_virtual_card` 工具都不接受时间参数。
请求体含 `occurredAt` 键返回 `400 VALIDATION`，工具参数含 `occurredAt` 等客户端时间字段则在调用 SDK 前抛出 `VALIDATION`。
两种拒绝都不移动资金、不写流水与 `CardConsumption`。
入账瞬间固定为 `demoNow()`（UTC+08:00 月窗口），断言只核对渲染金额、余额、流水与消费行。

补办卡继承源卡的结算账户，缺失绑定只按显式前驱修复，绝不回退默认账户。
补办卡与源卡共享同一连续月度额度（`banking-sdk/card-family.ts` 双向遍历 `replacedByCardId`），历史 `CardConsumption` 保持原卡归属不改写。

卡片集合按 id/type/状态断言，不使用固定卡片总数。
mock 夹具播种 `card_credit`/`card_debit`，演示种子（`prisma/seed.ts`）另有 `card_virtual`。
`lA` 补办后为「补办 ACTIVE 信用卡 + LOST 源卡 + DEBIT + VIRTUAL」，由类型/状态推导而非硬编码。

`tests/helpers/db.ts#truncateAll()` 清空 `prisma/schema.prisma` 的每一个 model（含无关系的 `CardConsumption`）。
套件不得在 `useFreshDatabase()`/`resetDatabase()` 之后再自行逐表清理。
新增 model 必须同时补进 `truncateAll`，否则 `helpers/db-truncate.test.ts` 失败。

## 面板声称的覆盖

确认/MFA 面板只在安全网关从真实工具调用持久化 `PendingAction` 后出现；模型散文不创建面板。
`unit/agent`（`write-continuation*.test.ts`、`system-prompt.test.ts`）与 `integration/write-continuation.test.ts` 覆盖「声明写操作却只用散文声称面板/等待确认、未发出工具调用」的场景：服务端做一次有界续接，仍无写入时以服务端叙述发布真实未提交状态，伪造声称绝不进入会话记录。
同一覆盖断言「参数齐全→续接后真实发起（打开真实网关闸门）或被网关拦截」以及「信息不足→正常澄清，不消耗续接预算」。
`e2e/panel-claim.e2e-helper.ts#findConfirmationPanelClaim` 纯文本判定助手散文是否声称确认/MFA 面板已存在，`unit/panel-claim.test.ts` 覆盖其正/负例；否定表述与普通追问不误判。
`e2e/live-acceptance.e2e.ts#driveRedTool` 与相关场景经 `helpers.ts#assertNoFabricatedConfirmationPanel` 在「散文声称面板 + `/api/actions` 无待处理项 + DOM 无卡片」时显式判定失败，错误区分 cause=模型未发起受控工具与 cause=UI/测试原因。
`unit/planner/mock-amount-clarification.test.ts` 与 `app/nl-entry-http.test.ts` 覆盖「信息不足→澄清，不产生工具调用」，但澄清为结构化 `missing_details` 或纯文本追问，非“面板”声称。
细节见各子目录 CONTEXT.md。

## 卡片生命周期能力契约的覆盖

能力事实以 `lib/contracts/tool-catalog.ts` 与 `lib/contracts/card-management.ts` 为准：
`replace_card` 与 `apply_virtual_card` 是模型可调用的 RED 写工具，只有 `manual_add_card`/`manual_delete_card` 为人工专属。
这些用例只断言服务端事实与持久化行，不使用凭据、不调真实模型、不联网。

| 文件 | 覆盖 |
| --- | --- |
| `unit/card-tool-catalog.test.ts` | 目录真值：`replace_card` 存在、类型中立、RED/requiresReceipt/maxAttempts 3；模型目录内没有任何新建/删除实体卡工具 |
| `unit/agent/card-capability-guidance.test.ts` + `unit/agent/capability-guidance-markers.ts` | 遍历 `agent/messages/*.json` 全部语言目录，按句断言卡片管理指引不得否认 `apply_virtual_card`/`replace_card`，人工规则限定在新建/删除实体卡；`overbroadManualOnlyCardProhibitions` 的必判违规例（`Issuing or deleting physical debit and credit cards remains manual-only … cannot be included in an Agent workflow.` 及其 `Offer replace_card …` 后续句）与合规例 |
| `unit/agent/system-prompt.test.ts`（`system prompt card capability scope`） | 系统提示词的 `manual-only` 语句不得套用到已挂失卡的补办，实体卡人工规则限于新建 |
| `integration/card-replace-capability-contract.test.ts` | 真实网关路径下三种卡类型的 RED + MFA 可达性、验证前无副作用、验证后仅一张新卡与类型继承；非 `LOST` 源卡的 CONFLICT 且不改状态；重复请求落到同一张补办卡并可重放 |
| `integration/card-manual-only-management.test.ts` | `manual_add_card`/`manual_delete_card` 在代理路径上仍被拒绝，用户侧副作用快照不变 |
| `scenarios/test-18-card-capability-consultation.test.ts` | 补办咨询与歧义目标只澄清、不产生动作；指引信封不创建 `PendingAction`；话术不得否认真实能力；生产提示的人工专属规则限于「新建实体卡 + 注销卡片」并声明集合封闭，`replace_card` 覆盖任意类型已挂失卡且从不说成页面专属 |
| `scenarios/test-19-card-replace-credit-runtime.test.ts` | 生产运行时下已挂失信用卡的补办走 RED MFA，验证后仅一张补办卡、源卡仍 `LOST` |

话术断言绑定产品原文：`test-18` 与 `unit/agent/card-capability-guidance.test.ts` 读取目录与提示词的真实渲染结果，
因此改动 `agent/messages/*.json` 的卡片管理条目或 `agent/system-prompt.ts` 的 `manual-only` 语句时必须同时核对这两处。

## 常用命令

`pnpm test` 运行全部 Vitest 测试。
`pnpm exec vitest run tests/unit` 运行指定目录。
`pnpm typecheck` 检查类型。
`pnpm exec tsx tests/e2e/acceptance.e2e.ts` 运行浏览器验收。

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
