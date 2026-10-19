# 卡片页面

## 数据与交互

`page.tsx` 按请求读取演示用户的卡片，交给 `CardManager` 组合界面。
`CardManager.tsx` 恢复手动申请、刷新卡片数据并打开消费弹窗。
`CardChangeDialog.tsx` 展示新增、删除和验证操作。
`CardConsumeDialog.tsx` 展示单卡消费表单与该卡消费记录。

卡片新增和删除是模拟记录管理。
物理借记卡与信用卡的新增和删除只在页面办理，不能由助手调用。
冻结、解冻、挂失、补卡和分类限额调整采用独立工具策略。
虚拟卡申请与挂失卡补办可由助手发起，与其他敏感操作一样需要确认和验证码。

每张卡片的 CardTile 页脚提供“消费”入口。
消费弹窗使用 CardTile 呈现卡片，并展示关联账户、账户可用余额、月消费限额与当前可支付金额作为决策参考。

这些参考值全部取自服务端投影的 `CardView`，界面不做二次计算：

- 关联账户：`linkedAccountNumber`
- 账户可用余额：`accountAvailableBalance`
- 月消费限额：`monthlyLimit`
- 当前可支付金额：`payableAmount`，即 min(账户可用余额, 剩余月限额)

金额与限额以精确字符串下发，界面只用 `Money` 渲染。
消费金额以十进制字符串校验，不使用浮点运算。

入账时间由服务端业务时钟决定。
提交的请求体只含 `amount`、可选的 `category`/`merchant` 与 `executionKey`，不含 `occurredAt`。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/cards` | 读取当前卡片 |
| `GET /api/cards/changes` | 恢复未完成的手动申请 |
| `POST /api/cards` | 提交新增申请 |
| `DELETE /api/cards/[id]` | 提交删除申请 |
| `POST /api/cards/changes/[id]/verify` | 确认原申请并验证 |
| `POST /api/cards/changes/[id]/cancel` | 取消尚未执行的申请 |
| `POST /api/cards/[id]/consume` | 提交模拟消费 |
| `GET /api/cards/[id]/consumptions` | 读取单卡消费记录 |

## 修改约束

新增与删除使用 `security/manual-card-management.ts`。
服务端要求 RED 验证、所有权检查与强制审计。
表单不接收真实卡号、支付凭据或密码。
卡号由服务端生成并脱敏展示。

消费请求由服务端注入 `userId`，客户端不得发送。
每次消费尝试按“卡片 + 金额 + 分类 + 商户”生成 `executionKey`，重试同一尝试时复用，成功后重新生成。
消费失败按错误码映射提示：资金不足、超出月限额、卡片不可消费或通用失败；`VALIDATION` 拒绝时展示服务端返回的原因。
打开弹窗时只在弹窗内读取该卡消费记录，不在整页触发多次消费记录请求。

网络重试保留原请求标识。
验证与取消使用持久化申请标识。
关闭弹窗不等于取消已保存申请。
忙碌状态阻止重复提交与关闭。
刷新只采用最新请求结果。

手动申请不混入助手的待确认操作恢复。
消费相关测试钩子：`data-card-consume`（入口）、`data-card-consume-dialog`、`data-card-consume-card-id`、`data-card-consume-summary`、`data-card-consume-form`、`data-card-consumptions`、`data-card-consumption`（记录行）。
金额展示规则见
[financial-values.md](../../docs/cn/financial-values.md)。
验证入口见 `tests/e2e/card-management.e2e-helper.ts`。

## Notes for Agents

`POST /api/cards/[id]/consume` 拒绝任何携带 `occurredAt` 的请求体（400 `VALIDATION`）：入账时间归服务端所有，界面不发送该字段，也不要补充任何客户端时间。
