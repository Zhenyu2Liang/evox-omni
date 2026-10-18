# 单元与局部集成测试

## 目录职责

| 目录 | 内容 |
| --- | --- |
| [security](security/CONTEXT.md) | 权限、累计风险、验证、熔断与安全事件 |
| [planner](planner/CONTEXT.md) | DAG、参数、对话状态与展示 |
| [banking-sdk](banking-sdk/CONTEXT.md) | 金额、账户不变量与事务 |
| [agent](agent/CONTEXT.md) | 确认、会话、计划控制与模型适配 |
| [lib](lib/CONTEXT.md) | 身份键、数据工具与仓储原语 |

目录名称不表示所有测试都无需数据库。
安全、SDK 与执行权测试中包含真实 SQLite 用例。
模型适配测试可控制响应，但不得泄露凭据。

## 卡片能力契约

本目录根部与 `agent/` 共同守住「模型能用哪些卡片能力、哪些只能人工」的事实：

- `tool-catalog.test.ts`：全局目录不变量（穷尽清单、tier 与副作用独立、写工具无回执不得声明可重试）。
- `card-tool-catalog.test.ts`：卡片领域冻结事实。`replace_card` 是唯一的补办工具，write/RED/`static`/`requiresReceipt`，对 DEBIT、CREDIT、VIRTUAL 一体适用（不存在按卡类型分的变体工具）；
  `AGENT_TOOL_NAMES` 中没有任何新增/开卡/删除实体卡工具，唯一的发卡工具是 RED 的 `apply_virtual_card`；
  `manual_add_card`/`manual_delete_card`（`lib/contracts/card-management.ts`）是人工专属命令，不在工具目录内。
- `agent/card-capability-guidance.test.ts` + `agent/capability-guidance-markers.ts`：服务端话术契约。
  用 `fs.readdirSync` 发现 `agent/messages/*.json` 全部语言目录，对卡片管理条目按句断言不得否认 `apply_virtual_card`（申请/创建/虚拟卡）与 `replace_card`（补办/换卡/替换已挂失卡），
  人工办理规则必须显式限定在全新/新增/删除的实体卡上（不得含 `虚拟`/`补办`），
  并用 `renderConversationGuidance('card_management_required')` 与目录原文等值校验，确保断言针对服务端真正渲染的字符串。
  只约束「不得否认」与「人工规则须限定范围」，不规定修复后的完整措辞，也不要求模板为 `补办` 做广告。
- `agent/system-prompt.test.ts` 的 `system prompt card capability scope` 分组：复用同一标记词表检查模型可见提示词，
  `manual-only` 类语句不得套用到已挂失卡的补办上，实体卡人工规则须显式限定为全新物理卡记录，并保留「为挂失卡提供 replace_card」的正向表述。

这些用例是纯文本断言：不连库、不调模型、不联网。
它们证明服务端渲染的措辞与目录事实一致，不证明真实模型不再生成同类散文（那以 live 验收为准），也不覆盖网关授权与执行路径。
测试夹具只做分句、否定辖域与标记词表分类，不复刻产品逻辑。

## 执行与修改

运行：`pnpm exec vitest run tests/unit`。
按子目录运行时仍使用根 Vitest 配置。
时间边界可注入测试时钟或持久化时间。
安全冷却与租约需覆盖默认真实时钟路径。

必须通过实际模块验证业务规则。
不得在辅助函数中复制被测逻辑。
具体数据库约束见 [../CONTEXT.md](../CONTEXT.md)。
