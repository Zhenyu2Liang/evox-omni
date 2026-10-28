# Agent Provider 单元测试

## Intent

预算与纠错声明的适配测试位于 `agent/model-budget.test.ts` 和
`agent/providers/required-declaration.test.ts`，不在本目录。
传输完整性通过只证明响应结束，不证明其办理状态或余额正确。
展示事实的检查见 `agent/reply-safety.test.ts`。
覆盖 `@/agent/providers`：离线 mock "大脑"(`mock-responder` 的 `respond` 与 `respondWithGuidance`)、live 模型解析与 Pi 传输层完成语义。
多数用例纯内存、无数据库、不发起真实网络请求。
`provider-live`/`provider-runtime` 只校验 pi-ai 注册表与密钥解析，不证明真实模型稳定性。
`plan-limit-park.test.ts` 例外：它经 `runTurn`→`confirmAction` 跑真实 SQLite 与事件流。

## 关键区分

`respond(ctx)` 是纯状态机，直接产出工具调用或纯文本。
`respondWithGuidance(ctx)` 是插入了 `describe_turn` 控制工具的包装器，先声明本轮意图(`purpose`/`operations`)再产出真实工具调用。
mock 工作流请求在 `describe_turn.arguments` 上打 `workflow: true` 标记。

## 文件

- `provider-mock.test.ts` — `respond` 的模糊意图分类、转账两步解析、多轮复用、缺参/歧义澄清、失败叙述、被拦截的关卡调用。
- `mock-turn-declaration.test.ts` — `respondWithGuidance` 的 `describe_turn` 声明与后续真实工具/DAG 调用。
- `mock-plan-proposals.test.ts` — `respond` 的显式条件工作流 `submit_plan` DAG。
- `mock-plan-sequence.test.ts`、`mock-request-amounts.test.ts` — mock 金额与脚本解析。
- `mock-module-boundaries.test.ts` — 模块依赖边界(无持久化、无银行执行、无凭据)。
- `provider-live.test.ts`、`provider-runtime.test.ts` — 真实 pi-ai 注册表的模型 ID/端点/密钥解析与 provider 运行时。
- `provider-stream-completion.test.ts` — 真实 OpenAI 兼容流完成边界。
- `completion-transport.test.ts` — SSE 传输完成契约(UTF-8 拆分、EOF、HTTP 失败)。
- `model-failure.test.ts` — 永久/瞬时失败分类策略。
- `model-audit.test.ts` — 经 Pi 请求钩子记录模型证据。
- `plan-limit-park.test.ts` — 计划停泊为 `waiting_confirmation` 后确认执行(跨模块、用真实库)。

## 关键行为(已由断言钉死)

写出意图且参数齐全 ⇒ 真实工具调用：`mock-turn-declaration.test.ts:80-91`(freeze_card 用真实 cardId)、`93-114`(submit_plan 多卡冻结节点)、`152-174`(subscribe/redeem/cancel 绑定真实资源 ID)、`mock-plan-proposals.test.ts:17-28`(条件 DAG)。
参数不足 ⇒ 纯文本澄清、无工具调用：仅在 `provider-mock.test.ts:220-235`(缺失收款人/金额)与 `239-261`(同名歧义)。
`describe_turn` 声明参数形态：`{ purpose: 'conversation'|'query'|'advice'|'operation', operations: string[], workflow?: true }`。

## 证据边界 / 已知空白

本目录的 `mock-turn-declaration.test.ts` 与 `mock-plan-proposals.test.ts` 不覆盖参数不足的澄清，也不使用 JSON `{"guidance":{"code":"missing_details"}}`。
`missing_details` guidance 协议由 `tests/unit/planner/`(`reply-format`、`mock-amount-clarification`、`tool-timeline`、`conversation-policy`)与 `tests/integration/decision-guidance` 断言，不在本节点。
本节点没有断言"模型用散文声称等待确认/请确认但未发出工具调用被拒绝/纠正/暴露"的用例；最接近的是 `provider-mock.test.ts:266-287`(失败叙述不宣称成功)与 `314-327`(被拦截时产出 operationPrepared 且不重复调用、不宣称资金已动)。

## 约束

只用真实模块与 Pi faux 辅助，不在测试中复制被测逻辑。
不得据文件数量宣称覆盖完整；真实模型稳定性需独立 live 验收。
`provider-mock.test.ts` 顶部保留了一段遗留的 "STAGING COPY" 头注释，已不代表当前位置，勿据此迁移文件。

## 运行

`pnpm exec vitest run tests/unit/agent/providers`。
本目录无子目录，无路由表。
