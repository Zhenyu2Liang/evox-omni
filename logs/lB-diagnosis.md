# lB 诊断笔记（本 worktree 实测静态定位）

## 缺陷 1 — 客户端整页崩溃 `Financial value must be nonnegative.`
- 抛点：`lib/decimal.ts:35-39 nonNegativeDecimal()`（line 37 throw）。
- 唯一把可能为负的业务值送进非负闸门的客户端路径：
  `components/banking/HoldingFacts.tsx:89` `${rateRatioToPercent(profitRate)}%`
  → `lib/decimal.ts:61-63 rateRatioToPercent()` → `nonNegativeDecimal(ratio)`。
- `HoldingView.profitRate` 可以是负数（亏损持仓）；一旦负值出现，客户端渲染异常 → 整个页面白屏
  → `/agent` 的 `textarea[data-chat-composer="true"]` 不再渲染 → live 场景第一步 60s 超时。
- 同族 grep 结果：`nonNegativeDecimal` 其余调用点都在服务端金额/份额/净值校验
  （`security/security-gateway.ts:652,686,697`、`banking-sdk/investment.ts:124,145,219,364,542,926,1001,1004`、
  `banking-sdk/valuation.ts:73`、`lib/contracts/command.ts:31`），语义正确，不应改动。

## 缺陷 2 — 聊天投资卡是「变更前」的陈旧持仓
- `agent/card-emitter.ts` 只对 **读** 工具投影 `investments` 卡：`list_investments`(:142)、
  `get_investment_holdings`(:148)、`compare_investments`(:154)。
- `subscribe_investment` / `redeem_investment`（`agent/tools/investment.ts:303,508`）是 **写** 工具，
  emitter 没有对应 case → 写成功后聊天里**没有新的持仓卡**，页面上最后一张 `investments` 卡仍是
  变更前（B0 阶段「我的持仓」）的快照。
- 与上一轮 live 证据吻合：B1(+1000)/B2(按金额赎回 2000) 在 DB 层全部通过，但聊天卡显示
  份额 `4999.864825`（= `prisma/seed.ts` 的 `holding_wenjiana` 种子值），而 DB 已变成
  `4034.334266`。即卡本身陈旧，断言没有过时。
- 修法方向（与 `set_card_limit` → `cards` 卡的既有模式一致）：写工具结果里带上**写后重读**
  的 `holdings`，由 emitter 投影成 `{type:'investments', data:{holdings}}`。
