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

根部三个 `weixin-*.test.ts` 不连库、不调模型：
`weixin-presentation.test.ts` 断言卡片/事件渲染，`weixin-channel.test.ts` 断言 bridge 的受信边界、命令流、去重与 `locked` 对外文案；
`weixin-lock-presentation.test.ts` 专测「终止锁定」的上屏边界：`locked` 结果的四段全文（次数用完 / 熔断 / 解锁后仍锁 / 缺 `code`+`failure` 兜底）、`继续验证：/验证 <id>` 只属 `awaiting_mfa`、`security_event{kind:'locked'}` 撤销 gate 且不可复活、其他 `kind` 静默、`emptyNotice:false`、内部诊断不外泄、`label()` 未知值兜底、锁定卡去重。
覆盖清单与缺口见 [../CONTEXT.md](../CONTEXT.md) 的「微信通道覆盖」。
三个文件的假对象工厂可直接复用：`weixin-presentation.test.ts#setup()`（第 87 行）返回 `{ state: emptyState(), bank }`，`bank` 由 8 个 `vi.fn()` 字面量实现 `BankingChannel`，渲染函数直接吃手写 `ChatCard`/`AgentStreamEvent` 字面量；
`weixin-channel.test.ts#fixture()`（第 16 行）另建 `WeixinBridge(state, bank, sender, save)` 与 `message(text, id)` 消息工厂，`sender` 只需 `send(to, text, clientId, contextToken)`，`save` 为空 `vi.fn()`，无 `WeixinStore` 替身（store 用例用真实临时目录）。
`weixin-lock-presentation.test.ts#fakeChannel(outcome)` 把同一个 `ActionResult` 塞进 `settle`，配 `message(text, id)`、`lastReply(sender)` 与 `lockedText(reason)` 模板；
参数化用例按 `outcome` 各建一个 channel，避免投递去重干扰。
回复断言惯用 `sender.send.mock.calls.at(-1)?.[1]` 取文本后 `toContain`/`not.toContain`；锁定终态整句则用 `toBe` 与四段模板全等比较。

本目录没有脚本化模型驱动生产 `runTurn` 的用例。
`agent/run-turn-failure.test.ts` 替换 `createBankingAgent` 工厂，`write-continuation*.test.ts` 用假运行时且不碰数据库。
需要「`scriptedProvider` → 生产 `runTurn` → SQLite 断言」骨架时用 `tests/integration/write-continuation.test.ts`，说明见 [../integration/CONTEXT.md](../integration/CONTEXT.md)。
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

## 卡片展示（CardTile）不在本目录

本目录没有用例导入 `components/banking/CardTile`；`renderToStaticMarkup` 覆盖的是聊天卡、审批/MFA 卡与解锁面板。
仅有的两个 `components/banking/*` 导入是 `planner/tool-diagnostics.test.ts` 的 `AgentTaskTimeline` 与 `planner/investment-purchase-display.test.ts` 的 `InvestmentProductTile`。
`components/banking/card-account-display.ts` 的四个纯函数与 `components/chat/cards/CardsCard.tsx` 都没有单元用例。
`CardTile` 自身不输出任何 `data-*`：`data-card-id`/`data-card-list`/`data-card-consume`/`data-card-delete` 由 `app/cards/CardManager.tsx:191` 的包裹层发出。
展示文案真值在 `lib/i18n/messages/business.zh-CN.json:47-69`（类型 `debit`/`credit`/`virtual`，状态 `active`/`frozen`/`lost`/`pending`，`limit`/`available`/`monthlyLimit`、`replaced`、`linkedAccount`、`accountBalance`、`usableBalance`、`linkedAccountMissing`、`linkedAccountUntrusted`、`cardUnavailable`、`cardFrozenNotice`、`cardLostNotice`）。
单元层只断言 DTO 与脱敏：`banking-sdk/card-linked-account.test.ts`、`banking-sdk/card-consumption.test.ts`、`lib/mask.test.ts`（`****8821`/`************8821`）。
卡片 DOM 断言（`CARD_LABEL`、`readCardTileRows`、`assertLinkedAccountTileLabels`）只在 `tests/e2e`，见 [../e2e/CONTEXT.md](../e2e/CONTEXT.md)。
`weixin-presentation.test.ts:23` 的 `type:'cards'` 用例只断言微信文本含 `¥87.66`，不是 React 渲染。

## 终止锁定与内部诊断的上屏边界

`@/lib/public-text`（`isInternalDiagnostic`/`safePublicText`/`securityNotice`）是唯一把内部诊断转成公开文本的漏斗。
锁定终态文案一律由 typed `code`/`reason`/`attemptsLeft` 决定，渲染层从不读服务端 `message`。
按层覆盖：

| 文件 | 覆盖（行锚点） | 纯度 |
| --- | --- | --- |
| `lib/public-text.test.ts` | `HOSTILE_INPUTS` 判为内部诊断（28-35）、不回显原文（37-47）、白名单业务错仍可本地化（49-60）；`securityNotice` 的 `MFA_FAILED`/`MFA_LOCKED`/`CIRCUIT_OPEN`/`security_event{kind:'locked'}`（64-92） | 纯：无 DB、无 HTTP、不产生真实锁定 |
| `security/mfa-failure-contract.test.ts` | 真实网关 `authorizeAction` 三连错 → `status:'locked'`、`PendingAction`/`MfaChallenge` 落 locked、重试正码仍 `CIRCUIT_OPEN`；`message`/`failure.reason` 不含 marker（101-157） | 真实 SQLite 网关路径，非 HTTP |
| `agent/turn-security-event.test.ts` | 真实 `securityGateway.handleToolCall`（`tests/helpers/faux-agent.ts:125`）：`security_event` 恰好一条、`kind:'locked'`、typed `code`/`reason`、`message` 为 `undefined`（50-82）；`publicToolSummary` = `chat.error.securityLocked`（84-99） | 真实 SQLite（`useFreshDatabase`），不调真实模型 |
| `agent/providers/provider-mock.test.ts` | marker 只作输入 `BLOCK_PREFIX`（47、315、330）；被拦的 YELLOW/RED 回 `operationPrepared` 且从不声称已执行（314-342） | 纯：无 DB、无 HTTP |
| `planner/locked-card-rendering.test.ts` | `MfaCard` locked：`data-mfa-locked` + `chat.error.actionLocked` + `cards.terminal.locked` + `pages.security.unlockDescription` + `href="/security"`，无 `<input>`/`<button>`/`/验证`/`继续验证`（85-107）；`awaiting_mfa` 保留入口（109-118）；`ApprovalRecord` locked（120-132）；`security_event` 敌意 `message` 折叠为 typed 通知（134-155）；`settleAction` 缺码默认 `MFA_LOCKED`、已有 code 优先，`publicToolSummary` 与 `ToolEventList` 同源（157-194）；`MessageBubble` 敌意 system 文本回落 `chat.error.securityDenied`（196-210） | 纯：`renderToStaticMarkup`，无 DB、无 HTTP |
| `security/unlock-panel-render.test.ts` | `app/security/UnlockPanel.tsx` 的 `data-unlock-*`（135-139）、`data-unlock-impact`（182）、`lockedDescription`/`actionLocked`/`unlockDescription` 与「重新发起操作」半边（84-98）、唯一 `aria-label={t('security.reset.codeLabel')}` 输入 + 提交 + `role="status"`（100-119）、无 marker/无 `MFA_CODE`（121-138）、解锁态仍渲染面板（140-157）；只切断面形态，解锁语义正文归 `unlock-panel-notice.test.ts` | 纯：`vi.mock('next/navigation')`，无 DB、无 HTTP |
| `security/unlock-panel-notice.test.ts` | `security.reset.*` 四段解锁语义：`lockReason` 按权威失败次数插值且 `{count}`/`{max}` 无残留、`lockedActionState`、`reinitiate` 的整句字面量 `REINITIATE`、`recovery`（60-73、85-96）；解锁态仍出 `reinitiate`/`recovery`/`lockedActionState` 且无锁定原因（128-138）；`data-unlock-reinitiate` 挂在承载整句的 `<p>` 上、两种熔断状态都在（75-83、98-126）；无 marker/无 `MFA_CODE`（140-156） | 纯：`vi.mock('next/navigation')`，无 DB、无 HTTP |
| `security/developer-reset-panel-hook.test.ts` | `app/security/ResetBreakerButton.tsx` 在开发者模式下渲染 `data-developer-breaker-reset-panel`，包裹按钮钩子 `data-developer-breaker-reset` 与 `security.reset.developerOnly` 文案（43-57）；非开发者模式整块渲染空串（59-65） | 纯：真实 `DeveloperModeProvider` + `LocaleProvider`，无 DB、无 HTTP |
| `weixin-lock-presentation.test.ts` | 四段锁定全文与 `lockedText(reason)` 全等（95-127、154-162）、`awaiting_mfa` 的唯一续接入口与剩余次数（129-152）、`security_event{kind:'locked'}` 撤销 gate 且不可复活（170-184）、其他 kind 静默（186-191）、`emptyNotice:false`（193-198）、敌意 payload 不上屏（200-210、214-249）、`label()` 兜底（251-265）、锁定卡去重（268-288） | 纯：假 `BankingChannel` + `emptyState()` |
| `planner/tool-feedback.test.ts` | `debugDetail` 可留内部纠错原文，公开 `summary`/`publicToolSummary` 只出目录文案；guard 原文与 `internal-node-*` 只在 developer 模式出现 | 纯 |
| `planner/tool-diagnostics.test.ts` | locked `MfaCard`/`ConfirmationCard` 出 `cards.terminal.locked` 且无按钮（60-70）；私有 `statusMessage` 只在 developer 模式出现（72-86） | 纯 |
| `lib/activity-presentation.test.ts` | 业务活动只渲染封闭业务字段，隐藏 id、`toolName`、`toolResult`、`userRequest`、`sessionId` | 纯 |

同一锁定事实分三层钉住：网关（`mfa-failure-contract.test.ts`）、事件投影（`turn-security-event.test.ts`）、渲染（`locked-card-rendering.test.ts`、`weixin-lock-presentation.test.ts`、`unlock-panel-render.test.ts`、`unlock-panel-notice.test.ts`）。
`agent/providers/provider-mock.test.ts` 头部的「STAGING COPY / 临时 runner config」注释是迁移残留：文件已在最终位置，按普通用例运行，不需要任何临时配置。
生产投影 `agent/turns/events.ts:92-96` 与测试侧 `tests/helpers/scenario.ts:304-308` 发出同一组 typed 字段，两者都不带 `message`。
`turn-security-event.test.ts` 因此证明「真实网关 + 测试侧投影」，不是生产 `agent/turns/events.ts` 本身。
传输层仍原样转发服务端文案：`planner/action-contract.test.ts:162-170` 用桩造 `message:'Verification locked'` 断言 `error` + `action_settled` 透传；渲染层不读该文本，两者不冲突。
`planner/action-attention-state.test.ts:117-134` 断言同一 actionId 的 `error` + `action_settled{locked}` 关闭 MFA 弹窗并保留 `error`/`errorCode`。

文案全在目录里：解锁语义四段 `security.reset.lockReason`（`{count}`/`{max}` 插值）、`security.reset.lockedActionState`、`security.reset.reinitiate`（整句「解锁后需重新发起并重新确认，原操作不会自动执行。」）、`security.reset.recovery`，真值以 `lib/i18n/messages/business.zh-CN.json` 为准。
`security/unlock-panel-notice.test.ts:60-73` 按目录真值逐条断言这四段，并用字面量 `REINITIATE` 夹住 `reinitiate` 的整句（`:70`、`:82`、`:132`）；`data-unlock-reinitiate` 挂在承载该整句的 `<p>` 上、两种熔断状态都存在（`:75-83`、`:98-126`）。
`unlock-panel-render.test.ts` 只切断面形态：`data-unlock-*`、单一验证码输入、`role="status"`、不外泄内部诊断；`pages.security.unlockDescription` 与 `chat.error.actionLocked` 的「重新发起操作」半边仍由它断言（`:84-98`）。本目录没有任何用例驱动 `POST /api/security/reset`（路由见 `app/security-workflow-http.test.ts`）：两个解锁面板用例都只做静态渲染。
解锁面板在两种熔断状态下都渲染常驻 `role="status"` live region（`unlock-panel-render.test.ts:117` ↔ `app/security/UnlockPanel.tsx:213`），因此在 `/security` 上做页面级 `[role="status"]` 扫描会连带面板文本（对照 `tests/e2e/helpers.ts:1197`）。

## 恢复、租约与任务控制的覆盖

本目录没有任何用例改写 `AgentRun.leaseExpiresAt`、`AgentSession.runLeaseExpiresAt`、`recoveryAttempts`、`nextRecoveryAt`，也没有 `vi.useFakeTimers`（唯一持有者 `planner/action-contract.test.ts`）。
租约过期与进程重启的真实时间取值改写位于 `../integration/`（`agent-durability.test.ts`、`model-checkpoint-boundaries.test.ts`、`confirmation-lease-contention.test.ts`、`process-restart.test.ts`）。

| 文件 | 覆盖 | 数据库 |
| --- | --- | --- |
| `agent/recovery-worker.test.ts` | 恢复宿主 worker 的 tick、停机、忙租约 `CONFLICT`、终态冲突、异常脱敏、批大小与 CLI 参数 | 纯：`vi.mock('@/agent/durable/service')`、`vi.mock('@/lib/db/repositories/agentRun')`，注入 `{ discover, recover, inspect? }` ports |
| `agent/durable-reply-repair.test.ts` | 已完成的纠错回复崩溃后按持久化阶段重放、不再耗模型请求、记为 `phase:'fallback'` | 纯：mock `@/lib/db/client` + 假 `BankingAgentRuntime` + `encodeCheckpoint` |
| `agent/durable-advice-context.test.ts` | 可信建议在某次授权恢复后仍生效；换用户消息后复活即 `CONFLICT` | 纯（同上骨架） |
| `agent/write-continuation-durable.test.ts` | 持久化续接的 `calls.length === 0` 分支与前台上限一致 | 纯（同上骨架） |
| `agent/write-continuation.test.ts` | `declaredWriteTools`/`hasWriteEvidence`/`pendingDeclaredWrites` 与一次性续接预算 | 纯 |
| `agent/task-control.test.ts` | `submit_plan` 持久化、`getTaskPlan`/`pauseTask`/`resumeTask`/`cancelTask`/`retryTask` 所有权，以及 `pending` 任务的 pause→resume→cancel | 真实 SQLite（`resetDatabase`） |
| `agent/task-cancel-revokes.test.ts` | 取消撤销已停靠 `PendingAction`、取消/确认竞态至多一次副作用、取消不伪造回滚 | 真实 SQLite（`resetDatabase`） |
| `planner/executor-execution-right.test.ts` | `AgentTask.executionToken` 被接管后，四个异步栅栏拒绝旧持有者 | 真实 SQLite（`useFreshDatabase`） |
| `planner/executor-claim-scope.test.ts` | 节点执行按 `(taskId, nodeId)` 的数据库 CAS 去重，非进程内 Map | 真实 SQLite（`useFreshDatabase`） |
| `planner/lifecycle.test.ts` | 计划 pause、cancel+补偿、retry、门控节点 resume | 纯（内存 ports） |
| `planner/task-node-error-contract.test.ts` | `updateTaskNode` 的 `P2025` → `NOT_FOUND` + `detail` | 纯（mock prisma client） |
| `lib/pendingAction.claim.test.ts` | `claimPendingAction` 恰好一次 `pending → confirmed`、作用域与状态更新 | 真实 SQLite（`resetDatabase`） |

计划级接管用 `executor-execution-right.test.ts` 的 `takeover()` 旋转 `executionToken`；它不是 agent-run 租约接管。
`planner/lifecycle.test.ts#resumePlan(plan, { nodeId, outcome }, deps, { now })` 是唯一的纯门控节点 resume 用例，不触库。
`@/agent/task-control` 层面（注入 `runTool` 的 `resumeTask`/`retryTask`）对 `waiting_confirmation` 任务没有直接用例：`agent/task-control.test.ts` 的 resume 针对 `pending` 任务，`agent/task-cancel-revokes.test.ts` 只经 `confirmAction` → `resumeTaskForAction` 间接恢复停靠节点。
`agent/**/*.test.ts` 另有 20 个同置套件（含 `durable/service`、`durable/recovery`、`durable/retry-policy`、`durable/control-recovery`），由根 `vitest.config.ts` 的 `agent/**` include 收集，不在本目录。

## 执行与修改

运行：`pnpm exec vitest run tests/unit`。
按子目录运行时仍使用根 Vitest 配置。
时间边界可注入测试时钟或持久化时间。
安全冷却与租约需覆盖默认真实时钟路径。

必须通过实际模块验证业务规则。
不得在辅助函数中复制被测逻辑。
具体数据库约束见 [../CONTEXT.md](../CONTEXT.md)。
