# 银行业务展示组件

## 组件职责

| 组件 | 内容 |
| --- | --- |
| `AssetSummaryCard` | 资产、余额、额度与消费摘要 |
| `RecentTransactions` | 交易列表 |
| `CardTile` | 脱敏卡号、状态与限额 |
| `SubscriptionTile` | 费用、周期与下次扣费 |
| `InvestmentProductTile` | 产品及可选持仓 |
| `AnomalyBanner` | 异常记录与调用方提供的动作 |
| `AgentTaskTimeline` | 计划节点与执行状态 |

组件使用 `useI18n` 展示本地化标签。
金融值和状态来自调用方的数据。
SDK 类型通过类型导入使用。

## 修改约束

- 本目录不请求数据或执行银行业务。
- 交互回调由客户端调用方提供。
- 金额必须沿用通用组件的单位约定。
- 脱敏号码不得代替服务端资源标识。

界面测试方法见
[test-cases.md](../../docs/cn/test-cases.md)。
