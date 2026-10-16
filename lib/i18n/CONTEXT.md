# 界面本地化

## 职责与入口

| 入口 | 职责 |
| --- | --- |
| `shared.ts` | 语言校验、消息键类型、模板插值 |
| `server.ts` | 请求级 `getServerI18n()`，通过 Next cookies 读取 `banking_locale` |
| `LocaleProvider.tsx` | 客户端翻译上下文、cookie 持久化、服务端组件刷新 |
| `LocaleText.tsx` | 面向服务端安全原语的客户端叶子组件，支持渲染回调 |
| `messages/` | 应用框架、对话、业务与页面文案的中英文对照目录 |

## 投资标签

`business.investments.*` 提供投资业务的中英文标签，语义如下：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `business.investments.lastPurchase` | 最近申购 | Last purchase | 最近一次申购的时间或说明 |
| `business.investments.purchases` | 申购记录 | Purchases | 申购记录区块标题 |
| `business.investments.purchaseCount` | 共 {count} 笔 | {count} purchases | 申购笔数，模板含 `{count}` 占位符 |
| `business.investments.addedToExisting` | 已加购 | Added to existing | 对已持有产品再次申购的标记 |

## 卡片标签

`business.cards.*` 提供卡片业务的中英文标签，语义如下：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `business.cards.linkedAccount` | 关联账户 | Linked account | 卡片关联的账户名称或编号 |
| `business.cards.accountAvailable` | 账户可用余额 | Account available balance | 关联账户当前可用余额 |
| `business.cards.payableAmount` | 当前可支付金额 | Currently payable | 结合卡片额度与账户余额后当前可支付的金额 |

`pages.cards.consume*` 提供卡片消费界面（模拟消费表单、消费结果提示与消费记录）的中英文标签。

## 显示映射（display-sources）

`messages/display-sources.json` 将界面已知的静态元数据值映射到消息键，供展示层翻译。
映射键必须与源值完全一致，值必须指向已存在的消息键（单元测试校验该不变量）。
含动态内容的源值无法静态映射，展示层按原样保留、不翻译。
例如部分赎回策略值 `部分赎回（本金 ¥…／共计 ¥…）` 内嵌金额，保持原样显示，不得添加正则或模式匹配。
完全赎回策略值 `全部赎回该笔持仓` 映射到 `chat.value.fullRedemption`。

## 修改约束

- 默认 `zh-CN`，即使浏览器偏好英文；仅 `en` 选择英文。
- 标识符、键名与注释使用英文，中文界面文案放入语言 JSON。
- 翻译完整模板；金融金额以已格式化的精确字符串传入。
- 不得为插值或本地化格式将金额转换为二进制浮点数。
- 仅本地化静态界面元数据；保留用户文本、模型回复与金融事实。
- 切换语言只更新展示，不重挂载对话、不重提交操作、不改变授权。
- 偏好 cookie 不是身份 cookie，不授予任何权限。
- 服务端数据访问保留在服务端模块；本地化不构成客户端数据库导入的理由。
- 中英文目录必须同时登记相同键与相同占位符，单元测试校验键与占位符一致性。

## 验证

`tests/unit/lib/i18n.test.ts` 校验语言目录与插值。真实浏览器验收流程校验默认语言、
持久化、客户端/服务端翻译与对话保留。
