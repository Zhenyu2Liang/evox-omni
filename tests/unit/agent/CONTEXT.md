# Agent 局部测试

## 范围

本目录覆盖确认、验证、取消与计划控制。
也覆盖工具结果替换、续接失败与模型适配。

- `confirmation-idempotency.test.ts` 检查重复决定与所有权。
- `confirmation.test.ts` 检查决定结果与审计。
- `task-control.test.ts` 检查任务持久化和控制。
- `task-cancel-revokes.test.ts` 检查取消与已执行事实。
- `message-normalize.test.ts` 检查工具结果组与后续历史。
- `run-turn-failure.test.ts` 检查实际结果与失败续接。
- `system-prompt.test.ts` 检查系统提示词与工具目录分级一致并保留幻象规则，并断言确认/验证面板只在真实受控写工具结果停放后才存在、无该结果时禁止声称已发起或在等待确认；
  `system prompt card capability scope` 分组按句扫描 `manual-only` 类语句，断言「人工办理」规则从不套用到已挂失卡的补办（`replace_card`）上，且实体卡人工规则显式限定为全新物理卡记录，同时保留「为挂失卡提供 replace_card」的正向表述。
- `card-capability-guidance.test.ts` + `capability-guidance-markers.ts` 检查卡片生命周期能力话术契约：
  用 `fs.readdirSync` 发现 `agent/messages/*.json` 全部语言目录（不硬编码文件名），
  按句断言 `card_management_required` 及同类卡片管理条目不得否认 `apply_virtual_card`（申请/创建/虚拟卡）与 `replace_card`（补办/换卡/替换已挂失卡），
  人工办理规则必须显式限定在全新/新增/删除的实体卡上（不得含 `虚拟`/`补办`），
  有 `capabilities` 条目的目录还须提及 `补办`/`挂失`，
  并用 `renderConversationGuidance('card_management_required')` 与目录原文等值校验，确保断言针对服务端真正渲染的字符串。
  `capability-guidance-markers.ts` 只做纯文本分类（分句、否定辖域、标记词表），不复刻产品逻辑，被上述两个测试共用。
- `read-tool-boundaries.test.ts` 检查读取工具参数校验与模型可见错误信封。
- `durable-reply-repair.test.ts` 检查回复修复的持久续接、崩溃不重复修复与凭据脱敏。
- `durable-advice-context.test.ts` 检查授权恢复时建议用途与来源请求一致性。
- `recovery-worker.test.ts` 检查恢复主机批处理、关闭与参数校验。
- `write-continuation.test.ts` 直接检查 `declaredWriteTools`、`hasGateEvent`、`hasWriteEvidence`、`pendingDeclaredWrites`，
  并用假 `BankingAgentRuntime` 驱动声明写续接的一次性预算：预算先于模型请求持久化、只续接一次、
  同一候选二次调用为空操作、guidance 与协议信封不消耗预算、仍无写证据时改发服务端 `declared_unsubmitted` 文本。
- `write-continuation-durable.test.ts` 用假运行时证明 `continueDurableRun` 的 `calls.length === 0` 分支
  对已完成却未提交的声明写执行同一条有界续接策略，并保持「预算先于请求」的持久化顺序。
- `providers/` 检查离线响应、live 适配配置、流完成证据与模块边界。

## 证据与隔离

确认、验证和任务控制用例使用真实模块与测试库。
只检查模型适配配置不等于完成 live 请求验收。
结果文字必须区分服务端结果与模型输出。
`provider-live.test.ts` 仅覆盖模型解析/身份/密钥，不覆盖回复格式或面板语义。
`write-continuation*.test.ts` 注入「只声称面板、却无受控写工具调用」的模型输出，
验证服务端的有界续接与 `declared_unsubmitted` 纠正文案，并断言伪造面板文案不会被发布；
它们不证明真实 live 模型不再生成该散文，真实模型稳定性仍以 live 验收为准。
`providers/provider-mock.test.ts` 的面板场景须先有真实停放调用。

卡片能力话术用例是纯文本断言，不连库、不调模型、不联网。
它们证明目录与系统提示词的**措辞**不再否认 `apply_virtual_card`/`replace_card`，
不证明真实模型不再生成同类散文（那以 live 验收为准），也不覆盖网关授权与执行路径。
能力事实以 `lib/contracts/tool-catalog.ts` 与 `lib/contracts/card-management.ts` 为准：
只有 `manual_add_card`/`manual_delete_card` 是人工专属，`apply_virtual_card` 与 `replace_card` 均为模型可调用的 RED 写工具。

熔断状态按所有者持久化，不是进程内会话计数。
测试隔离规则见 [../../CONTEXT.md](../../CONTEXT.md)。
并发确认与进程恢复还需结合跨模块测试。
不得根据本目录文件数量宣称覆盖完整。

运行：`pnpm exec vitest run tests/unit/agent`。
