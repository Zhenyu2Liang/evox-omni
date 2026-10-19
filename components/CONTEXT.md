# 界面组件

## 职责与目录

组件展示服务端数据并管理界面交互。
组件不决定业务权限或持久化资金变化。

| 目录 | 职责 |
| --- | --- |
| [ui](ui/CONTEXT.md) | 金额、按钮、容器、表格与对话框 |
| [banking](banking/CONTEXT.md) | 资产、流水、卡片与理财展示 |
| [charts](charts/CONTEXT.md) | 原生 SVG 图表 |
| [security](security/CONTEXT.md) | 权限说明、安全事件与熔断状态 |
| [chat](chat/CONTEXT.md) | 对话、历史、流事件与授权交互 |
| [chat/cards](chat/cards/CONTEXT.md) | 结构化业务结果与历史授权记录 |
| `runtime/` | 运行记录与事件展示 |

`index.ts` 和子目录索引保持中性导出。
交互或本地化组件在叶子模块声明客户端边界。
是否使用客户端组件，以模块指令和 Hook 为准。

## 数据与显示

共享契约来自 `lib/contracts`。
SDK 数据类型使用类型导入。
工具结果通过共享输出契约和传输校验。
组件必须保留业务状态与操作身份。

金额显示使用 `Money` 或 `DecimalMoney`。
部分赎回后的持仓按剩余本金（`holding.amount`）及估算市值与收益显示。
已加购持仓显示最近申购时间（`lastPurchaseAt`）与申购记录数（`purchases`），
投资产品卡与对话投资卡片以“已加购”标记加购。
虚拟卡（`type === 'VIRTUAL'`）展示关联账户
（`linkedAccountNumber`，缺省回退 `linkedAccountId`）、账户可用余额
（`accountAvailableBalance`）与当前可支付金额（`payableAmount`）；字段缺失则不渲染。
`accountAvailableBalance` 是关联活期账户的可用现金，不是授信额度；
`信用额度`（`business.cards.limit`）与 `可用额度`（`business.cards.available`）标签仅用于 CREDIT 卡。
图表只有坐标可转换为普通数值。
本地化使用 `lib/i18n`，不改变金融值与资源身份。
颜色与圆角使用 `app/globals.css` 中的主题。

## 修改约束

- 客户端不得导入 Prisma 或服务端业务执行函数。
- 用户操作通过 API 获得服务端结果。
- 历史授权记录不得重复提供执行按钮。
- 新增卡片类型时，必须更新 `CardRenderer` 的穷举分派。

对话显示规则见
[chat-presentation.md](../docs/cn/chat-presentation.md)。
验证方法见 [test-cases.md](../docs/cn/test-cases.md)。
