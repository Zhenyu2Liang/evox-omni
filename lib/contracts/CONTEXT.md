# 共享契约（类型与能力目录）

## 意图

本目录只放类型、能力目录与纯归一化函数，不访问数据库、不做权限判定。
业务执行、安全网关与界面投影由调用层实现。

## 能力目录（`tool-catalog.ts`，唯一事实来源）

`TOOL_CATALOG`（31–62 行）每项为 `ToolCatalogEntry`（8–18 行）：

```ts
interface ToolCatalogEntry {
  /** Whether the capability may be exposed to and invoked by the agent. */
  agentEnabled?: boolean;
  category: ToolCategory;
  effect: ToolEffect;                       // 'read' | 'write' | 'workflow'
  defaultTier: RiskLevel;                   // 'GREEN' | 'YELLOW' | 'RED'
  authorization: ToolAuthorization;         // 'static' | 'transfer_amount'
  description: string;
  /** Writes are retryable only when the runtime proves an atomic verified-receipt capability. */
  replay: ToolReplayPolicy & { requiresReceipt: boolean };
}
```

仅两个构造器决定默认策略（20–28 行）：

- `read(...)` → `effect:'read'`、`authorization:'static'`、`replay { safety:'read_only', maxAttempts:3, requiresReceipt:false }`。
- `write(category, tier, description, authorization='static')` → `effect:'write'`、`replay { safety:'idempotent', maxAttempts:3, requiresReceipt:true }`。
- `submit_plan`（59–61 行）手写为 `effect:'workflow'`、`defaultTier:'GREEN'`、`replay { safety:'reconcile_only', maxAttempts:1, requiresReceipt:false }`。

卡片类条目（逐字）：

```
47	  set_card_limit: write('card', 'YELLOW', 'Set a card category limit.'),
49	  freeze_card: write('card', 'RED', 'Freeze an owned card after confirmation and strong verification.'),
50	  apply_virtual_card: write('card', 'RED', 'Issue a virtual card after confirmation and strong verification.'),
51	  consume_virtual_card: write('card', 'RED', 'Spend from an owned virtual card against its linked checking account after confirmation and strong verification.'),
56	  report_lost_card: write('card', 'RED', 'Report an owned card lost. A lost card is permanent and cannot be revived.'),
57	  replace_card: write('card', 'RED', 'Replace an owned lost card with a new card after confirmation and strong verification.'),
58	  unfreeze_card: write('card', 'RED', 'Unfreeze an owned card.'),
```

`get_cards: read('card', 'Read owned cards and limits.')`（38 行）是唯一读取卡片的条目。

## 导出与工具名集合

- `CatalogToolName = keyof typeof TOOL_CATALOG`（64 行）；`TOOL_NAMES`（65 行）为冻结的键数组。
- `AGENT_TOOL_NAMES`（66 行）：`TOOL_NAMES.filter(name => catalogEntry(name)?.agentEnabled !== false)`。
- `isCatalogToolName`（68–70 行）、`catalogEntry`（72–74 行）。
- `tools.ts`：`ToolName` 直接指向 `CatalogToolName`；`ToolCategory` 为 11 个字面量联合（含 `card`）；`ToolDescriptor` 仅 `name/category/description`。

## 命令归一化（`command.ts`）

- `BankingCommand.toolName`（8 行）类型为 `ToolName | ManualCardCommandName` —— 手工卡片命令不属于目录工具。
- `MONETARY_FIELDS`（13 行）：`amount`、`creditLimit`、`monthlyLimit`、`expectedSettlementAmount`。
- `DECIMAL_FIELDS`（14 行）：`shares`、`expectedShares`、`expectedNetValue`，按十进制文本归一化。
- `redeem_investment`（55 行）描述为按份额或按金额赎回自有持仓，口径字段是 `mode`；`redeemAmount` 与 `expectedRedemptionAmount` 不在字段集合内。
- `canonicalCommandArgs`（16–22 行）去掉 `idempotencyKey`、递归归一化嵌套对象、把金额字段转十进制字符串。
- `prepareBankingCommand`（24–28 行）用 `requestDigest({ version:1, userId, toolName, args })` 生成 digest。

## 输出契约（`tool-output.ts`）

`BANKING_TOOL_OUTPUTS`（38–78 行）按工具名映射字段契约；只声明可引用路径，不强制字段存在。
卡片类读取写入同用 `card` 对象（21–23 行）：`id`、`type`（普通 `string`）、`network`、`numberMasked`、`status`、`creditLimit`、`availableLimit`、`monthlyLimit`、`limits`。
`freeze_card`、`apply_virtual_card`、`report_lost_card`、`replace_card`、`unfreeze_card`、`set_card_limit` 均映射到同一个 `card` 契约（67–77 行）。
`outputFieldAt`（80–90 行）按数组/对象路径解析可引用字段。

## 卡片管理契约（`card-management.ts`）

`AddDemoCardRequest`/`CardChange` 携带 `type: CardType` 与可选 `creditLimit`/`monthlyLimit`/`linkedAccountId`；`linkedAccountId` 注释明确为 “display only — the server validates ownership and account type”。
`ManualCardCommandName = 'manual_add_card' | 'manual_delete_card'`（33 行），仅用于手工卡片管理，不在 `TOOL_CATALOG` 中。

## 安全与风险类型

`risk.ts`：`RiskLevel = 'GREEN' | 'YELLOW' | 'RED'`；`PermissionTier` 为其别名；`TransferPolicy`。
`security.ts`：`SecurityDecisionKind`、`SecurityEvaluation`、`PendingActionStatus`（含终态 `needs_reconciliation` 与 `locked`）、`PendingAction`、`SecurityDecision`。
`runtime.ts`：`ReplaySafety`、`ToolReplayPolicy`、`ToolInvocationStatus`、`RetryDecision`、`VerifiedInvocationReceipt`、`WORKFLOW_EXECUTION_LEASE_MS`。
`agent.ts`：`ChatCard`、`ToolEventView`、`AgentStreamEvent`、`BusinessReceipt`。

## 约束

- 目录不设任何“按卡类型/按参数”的允许-拒绝表：`ToolEntry` 只有 category/effect/tier/authorization/description/replay。
- 全部条目都未设置 `agentEnabled`，因此 `AGENT_TOOL_NAMES` 当前等于 `TOOL_NAMES`；关闭某能力须显式写 `agentEnabled: false`。
- `authorization` 只有 `'static'` 与 `'transfer_amount'` 两种；卡片工具全为 `static`，金额风险由安全网关按 tier 计算。
- 所有 `write` 走 `requiresReceipt: true` + `idempotent`，回放依赖已提交回执。
- 新增/修改工具名必须同时更新 `tool-catalog.ts`、`tool-output.ts` 与调用层；不得在别处重复声明策略。
- 金额字段归一化名单只在此目录的 `command.ts` 维护。
