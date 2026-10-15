# 卡片页面

## 数据与交互

`page.tsx` 读取演示用户的卡片。
`CardManager.tsx` 恢复手动申请并刷新卡片数据。
`CardChangeDialog.tsx` 展示新增、删除和验证操作。

卡片新增和删除是模拟记录管理。
物理借记卡与信用卡的新增和删除只在页面办理，不能由助手调用。
冻结、解冻、挂失、补卡和分类限额调整采用独立工具策略。
虚拟卡申请与挂失卡补办可由助手发起，与其他敏感操作一样需要确认和验证码。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/cards` | 读取当前卡片 |
| `GET /api/cards/changes` | 恢复未完成的手动申请 |
| `POST /api/cards` | 提交新增申请 |
| `DELETE /api/cards/[id]` | 提交删除申请 |
| `POST /api/cards/changes/[id]/verify` | 确认原申请并验证 |
| `POST /api/cards/changes/[id]/cancel` | 取消尚未执行的申请 |

## 修改约束

新增与删除使用 `security/manual-card-management.ts`。
服务端要求 RED 验证、所有权检查与强制审计。
表单不接收真实卡号、支付凭据或密码。
卡号由服务端生成并脱敏展示。

网络重试保留原请求标识。
验证与取消使用持久化申请标识。
关闭弹窗不等于取消已保存申请。
忙碌状态阻止重复提交与关闭。
刷新只采用最新请求结果。

手动申请不混入助手的待确认操作恢复。
金额展示规则见
[financial-values.md](../../docs/cn/financial-values.md)。
验证入口见 `tests/e2e/card-management.e2e-helper.ts`。
