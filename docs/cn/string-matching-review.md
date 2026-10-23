# 字符串匹配审查

业务语义由银行智能体理解，执行条件由结构化数据校验。
正则表达式只用于协议、字段格式、脱敏和搜索。
词语匹配不能改写用户需求或证明金融操作结果。

## 当前规则

生产执行流程不按自然语言词表区分用途。
自然语言词表只存在于 `agent/providers/mock/`，用于离线脚本回复。
在线模型通过 `describe_turn` 声明本轮用途。
声明作为工具调用写入事件日志，但不显示为聊天工具卡。

声明包含以下结构化信息：

- 用途：`conversation`、`advice`、`query` 或 `operation`。
- 本轮能力名称、重复次数和顺序。
- 是否需要工作流（`workflow`）。
- 是否要求展示开发协议示例（`allowProtocolExamples`）。

本轮用途不能中途改变。
服务端拒绝同一轮内改写用途或已绑定的写入序列。
操作准备阶段可先声明前置查询。
查询确定对象和数量后，再绑定完整写入序列。
序列一旦包含写入，就不能扩大或替换。
每条新用户消息重新声明用途。
原始消息和历史上下文始终由 Pi 保存。
在线意图契约只含用途、能力序列、调用身份和原文字。
契约另含 `workflow`、`allowProtocolExamples` 2 个呈现开关。
契约不含指代、条件、草稿或澄清字段。

工具参数和任务图独立校验。
计划提交前检查所有节点的公开参数契约。
类型转换、未知字段和非法金额由校验拒绝。
工具执行还需所属用户校验、确认及多因子认证。

工作流检查声明中的写入次数和顺序。
顺序以任务图的稳定拓扑顺序核对。
额外查询可作为前置节点。
计划校验不增加或替换依赖边、金额和操作对象。

时间校验只处理 `runAtLocal` 或整数 `runAt`。
同时提供 2 个字段时，字段值必须一致。
用户句子中的日期不覆盖已声明参数。

模型失败使用供应商和传输的结构化证据。
`400`、`401`、`403` 等非暂时性状态码不自动重试。
`408`、`429` 和服务器失败可以重试。
网络失败、读取超时和缺少终止帧可以重试。
调用方取消请求时，不自动重试。
重试还须核对运行状态，防止重复执行金融写入。
错误文字仅供诊断，不能改变重试决策。

## 适用范围

以下目录包含字符串匹配，按用途分 3 类。
协议与字段格式、脱敏与搜索、闭合枚举。
业务语义不属于这 3 类，判定依据见下节。

- `agent/`：模型输入、回复展示、工具编排和恢复。
- `security/`：权限、认证、身份绑定和风险记录。
- `lib/`：字段解析、数据库查询、国际化和脱敏。
- `app/`、`components/`：接口和页面状态。
- `banking-sdk/`、`planner/`、`audit/`：业务执行、任务图和审计。

## 业务语义的判定来源

以下语义只由结构化字段确定。
词语匹配不能替代其中任何一项。

| 语义 | 判定依据 | 代码位置 |
| --- | --- | --- |
| 本轮用途与能力序列 | `describe_turn` 的结构化声明 | `agent/tools/turn-intent.ts` |
| 声明能否改写 | 服务端按用途和写入序列拒绝改写 | `agent/intent-context.ts` |
| 计划步骤、条件与时间 | 任务图节点、条件字段和明确时间字段 | `agent/tools/plan-compiler.ts` |
| 工具参数 | 公开参数 schema；未知字段和类型转换被拒绝 | `agent/tools/plan-parameters.ts` |
| 收款人与卡片 | 完整号码或精确的自有 ID | `security/recipient-resolution.ts`、`lib/banking-selectors.ts` |
| 执行结果 | `outcome`、`needsReconciliation` 和 `status` | `agent/grounding-facts.ts` |
| 重试决策 | 供应商状态码和传输结构 | `agent/providers/model-failure.ts` |
| 错误分类 | `AppError.code` 与资源类型 | `agent/task-fencing.ts`、`lib/db/repositories/task.ts` |
| 疑似注入 | 只写去重审计，不改变权限和熔断 | `security/injection-guard.ts`、`security/incidents.ts` |
| 执行键 | 服务端生成的 action、task、node 或调用标识 | `agent/financial-operation-key.ts` |

需要步骤顺序、条件和操作对象时，确认卡展示任务图。
用户确认的是明确对象、金额、时间及操作内容。
确认不能绑定模型可继续修改的自然语言字符串。

## 身份绑定与执行结果

执行身份只使用所属用户的真实资源字段。
搜索文字用于返回候选，不能直接证明选中身份。

| 位置 | 匹配限制 | 当前规则 |
| --- | --- | --- |
| `lib/phone.ts` 的身份判定 | 数字片段和掩码不能确定收款手机号。 | `phoneIdentityMatches` 只接受完整 11 位号码逐字符相等。 |
| `lib/phone.ts` 的候选筛选 | 片段和固定脱敏形状只能收窄候选。 | `phoneCandidateMatches` 和 `searchPhoneMatch` 只返回候选。 |
| `security/recipient-resolution.ts` 的跨字段匹配 | 姓名不能当成 `contactId`。 | 每个字段只匹配自己的含义。 |
| `security/recipient-resolution.ts` 的候选并集 | 互相矛盾的字段可能留下可执行候选。 | 所有已提供字段必须命中同一联系人。 |
| `lib/banking-selectors.ts` 的别名转换 | 卡片尾号、产品代码不能当成资源 ID。 | `*Id` 字段只绑定精确 ID，区分大小写。 |
| `agent/grounding-facts.ts` 的结果文字扫描 | 提到“待核对”不证明结果不明。 | 只认 `outcome`、`needsReconciliation` 和 `status`。 |
| `agent/task-fencing.ts` 的错误前缀 | 错误措辞变化会错误中止或继续恢复。 | 使用 `AppError.code` 和资源类型。 |
| `lib/db/repositories/task.ts` 的缺失节点错误 | Prisma 已提供缺失记录错误码。 | 将 `P2025` 映射为类型化 `NOT_FOUND`。 |
| `security/injection-guard.ts` 的攻击词语扫描 | 引用攻击句或正常请求也可能命中。 | 只写审计观察，不能决定权限。 |
| `security/incidents.ts` 的疑似注入计数 | 词语命中不证明真实越权。 | 只写去重记录，不累计信号、不锁定账户。 |

真实越权访问和业务失败仍可触发熔断。
金融结果仍由执行回执、账本及结构化状态确定。
身份判定、候选筛选与卡片选择器的当前规则见[号码与卡片身份解析](identity-resolution.md)。

## 保留的确定性匹配

这些匹配处理已定义的协议或字段。
格式正确不代表字段已经获得执行权限。

| 模块组 | 保留内容 | 判断依据 |
| --- | --- | --- |
| `providers/completion-transport.ts` | `data:`、换行和 `[DONE]` | SSE 协议终止条件。 |
| `components/chat/actions.ts` | SSE 帧边界、内容类型和错误码白名单 | 传输协议及事件契约。 |
| `providers/model-audit.ts` | 响应头名称白名单 | 限制保存的响应元数据。 |
| `providers/provider-live.ts` | 环境变量名称字符归一化、供应商枚举 | 配置名称转换。 |
| `agent/tools/money-schema.ts`、`agent/tools/decimal-schema.ts` | 无符号金额语法、小数位上限和规范化文本 | 参数格式校验。 |
| `money.ts`、`decimal.ts` | 精度、指数格式和千分位 | 金融字段解析；计算使用 BigInt 或 Decimal。 |
| `business-card-payloads.ts` | 金额、月份和业务状态格式 | 工具结果卡片的数据契约。 |
| `banking-sdk/transaction.ts`、`app/bills/page.tsx` | 月份字段 | 检查 `YYYY-MM`。 |
| `scheduled-time.ts` 的日期字段 | 本地时间格式及合法日期 | 明确时间字段转换。 |
| `MfaCard.tsx`、`CardChangeDialog.tsx` | 6 位验证码和金额格式 | 表单格式校验，服务端继续认证。 |
| `ContactManager.tsx` | 规范手机号格式 | 联系人表单字段校验。 |
| `lib/mask.ts` | 手机号、账号和卡号的展示脱敏 | 只做展示；不校验位数，也不判定身份。 |
| `agent/tools/result.ts` | 内部字段名集合、11 位号码形状 | 剥离服务端身份字段并脱敏手机号。 |
| `agent/banking-guidance.ts` | 单键 `guidance` 封套、封闭字段词表 | 只渲染服务端模板；自由正文被丢弃。 |
| `lib/internal-text.ts` | `__SECURITY_BLOCK__`、JSON 片段和堆栈的形状 | 判定内部诊断，不判断业务语义。 |
| `chat-history.ts` | 游标字符和长度 | 分页协议校验。 |
| `contracts/tool-output.ts` | 数组路径的数字段 | 输出路径类型校验。 |
| `context-compaction/batches.ts` | UTF-16 代理对边界 | 拆分摘要输入时保持字符完整。 |
| `db/url.ts` | `file:` 前缀 | 当前数据库驱动协议。 |
| `tool-diagnostics.ts`、`sensitive.ts` | 凭证字段及秘密文本脱敏 | 防止凭证进入模型或诊断页面。 |
| `durable/serialization.ts` | 凭证字段、Bearer 和密钥形状 | 持久化前脱敏。 |
| `durable/checkpoint.ts` | 服务端脱敏标记 | 检查恢复所需数据是否已经不可用。 |
| `i18n/shared.ts` | 已注册模板占位符 | 国际化插值。 |
| `i18n/display.ts`、`tool-feedback.ts` | 服务端固定文案和错误模板 | 只影响显示，不决定重试或权限。 |
| `AssistantMarkdown.tsx` | URL 协议白名单 | 禁止可执行链接协议。 |
| `navigation.ts`、`DeveloperModeProvider.tsx` | 路由精确值及路径前缀 | 页面导航和显示偏好。 |
| `history-request.ts` | 查询参数分隔符 | URL 拼接。 |
| `repositories/contact.ts`、`conversation-history-search.ts` | 查询文字包含匹配 | 返回搜索候选，不能绑定执行身份。 |

理财净值、份额和收益的解析与结算口径见[理财产品：净值与份额](investments.md)。
固定错误模板宜改成错误码、显示键和插值参数。
现有匹配只翻译已知模板，未知诊断使用普通提示。
文案变动不会影响操作结果或重试权限。
工具错误使用结构化错误码，保存规则见[银行工具契约](tool-contracts.md)。

## 枚举与内部标识

闭合枚举匹配保留。
匹配对象来自契约、目录或持久化状态。

| 模块组 | 匹配对象 |
| --- | --- |
| `permission-engine`、`security-gateway` | 工具名、风险等级和决策类型。 |
| `mfa`、`manual-card-management` | 认证状态和卡片变更状态。 |
| `banking-sdk/card.ts`、`banking-sdk/task.ts` | 卡片类型、前置状态和任务类型。 |
| `durable/`、`workflows/`、数据库仓库 | 运行、调用、节点和等待状态。 |
| `planner/dag.ts` | 比较运算符、字段类型和节点终态。 |
| `task-decision`、`task-rollback`、`manual-review` | 操作状态、可回滚工具及人工核对状态。 |
| `transcript-activity`、`useAgentStream` | 工具事件终态和版本更新规则。 |
| `PlanCard`、`MfaCard`、`confirmationStatus` | 卡片终态和合法控件。 |
| `RunHistory`、`ToolEventList` | 开发者可查看的状态。 |
| 执行键及审计前缀 | `nxe:`、`reconcile:` 等服务端生成标识。 |
| 安全阻断前缀 | 服务端生成的封闭阻断封套。 |

以执行键前缀选择存储类型是协议解析。
前缀不能由模型正文提供。
状态仍需核对所属用户、执行租约和提交校验。

## 模拟模型与测试

`providers/mock/` 的词语识别用于确定性脚本。
在线模型独立理解业务请求。
生产权限和金融参数校验不能依赖脚本识别结果。

模拟模型模块分组如下：

- `classifier`、`discussion`、`history`：选择脚本回复。
- `transfer-intents`、`card-intents`、`subscription-intents`：生成模拟工具候选。
- `investment-intents`、`plan-intents`、`amount-parser`：模拟参数和任务图。
- `request-steps`、`request-amounts`、`request-conditions`：生成模拟请求素材。
- `names`、`action-follow-up`、`narration`：读取测试素材。
- `compaction`：模拟摘要协议。

测试脚本必须经过与在线模型相同的网关。
测试不得用配置绕过用途声明、确认或多因子认证。
错误脚本参数必须被拒绝，而不能被生产代码猜测修正。

## 验证要求

回归测试验证边界，不固定自然语言措辞。
至少覆盖以下行为：

- 闲聊、建议、否定、引语和多轮指代保留原始上下文。
- 负金额、分数分金额和无效日期不创建授权。
- 搜索片段返回候选；同一片段不能直接绑定转账身份。
- 工具结果先展示，后续模型正文按原事件顺序展示。
- 错误和成功状态由结构化字段确定。
- 疑似注入观察重复出现时不锁定账户。
- 已登记写入在模型失败或重启后不重复执行。
