# SDK 不变量测试

## 范围

本目录直接调用模拟银行 SDK。
权限策略另由网关测试覆盖。
SDK 写入仍必须满足可信执行上下文与事务约束。

| 测试 | 内容 |
| --- | --- |
| `transfer.test.ts` | 账户、收款人、金额与余额 |
| `transfer-receipt.test.ts` | 原始回执重放与请求冲突 |
| `investment.test.ts` | 产品、持仓与申购赎回 |
| `investment-flow.test.ts` | 理财资金流水与一次入账 |
| `investment-precision.test.ts` | 申购结果重放与金额精度 |
| `investment-aggregation.test.ts` | 加购聚合与采购历史 |
| `investment-partial-redemption.test.ts` | 部分赎回、单次入账与去重 |
| `atomicity.test.ts` | 写入失败回滚与并发资金约束 |
| `idempotent.test.ts` | 相同执行身份的去重 |
| `subscription.test.ts` | 取消与提醒状态 |
| `anomaly.test.ts` | 收支方向、投资分类与异常筛查 |
| `card-replacement.test.ts` | 冻结/解冻可逆幂等、挂失终态与补办换卡不变量 |

具体文件和断言以当前目录为准。
金额使用十进制字符串与整数分。
回执缺失或请求身份冲突不能伪造原结果。
不支持从旧流水补造当前回执。
已持有产品的加购为聚合写入，采购身份存于 `purchaseHistory`。

## 已知缺陷

`investment-partial-redemption.test.ts` 的 Case B（同一身份重复部分赎回）当前失败。
原因：`banking-sdk/investment.ts:590-604` 的同身份回放查找嵌在
`if (current.status !== 'HOLDING')` 分支内；
持仓仍为 `HOLDING` 时，相同身份的重复部分赎回会落到写入路径并再次入账。
这与 SDK 自身契约冲突（`investment.ts:558-564`、`types.ts:355-364`）。
修复归属 banking-sdk；该用例不得弱化或跳过。

## 执行与数据

运行：`pnpm exec vitest run tests/unit/banking-sdk`。
数据库和失败注入见
[tests/helpers/CONTEXT.md](../../helpers/CONTEXT.md)。
金融单位规则见
[financial-values.md](../../../docs/cn/financial-values.md)。
