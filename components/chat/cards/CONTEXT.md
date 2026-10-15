# 对话业务卡片

## 数据与分派

`CardRenderer` 按 `ChatCard.type` 穷举分派。
共享类型定义在 `lib/contracts/agent.ts`。
工具输出先经服务端与传输契约校验。
卡片只展示结构化结果。

支持余额、转账、流水、消费、卡片、理财和订阅。
联系人、资产概览、定时记录与执行回执也有独立展示。
异常、计划和错误分别使用对应卡片。
新增类型时，必须更新分派与展示测试。

## 授权与状态

`confirmation` 与 `mfa` 历史卡片使用 `ApprovalRecord`。
当前交互由父目录 `ApprovalRequest` 提供。
`ConfirmationCard` 与 `MfaCard` 提供该交互的具体控件。
`confirmationStatus.ts` 解释持久化操作状态。
终态记录不能因保留 RED 元数据而重新要求验证。

`ReconciliationCard` 展示结果待核对的操作。
它由对话界面单独组合，不属于卡片联合类型。
结果未知时不得显示已成功、已失败或资金未变。

`PlanCard` 展示节点与计划控制。
控制回调传递所属计划标识。
暂停、取消与恢复规则由服务端执行。

## 展示约束

金额、收款人与状态必须取自对应业务结果。
电话号码使用脱敏显示。
资源标识和执行身份不能由显示名称替代。

规则与映射见
[chat-presentation.md](../../../docs/cn/chat-presentation.md)。
验证入口见
[tests/unit/planner/CONTEXT.md](../../../tests/unit/planner/CONTEXT.md)。
