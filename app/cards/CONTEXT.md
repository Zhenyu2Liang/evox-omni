# 卡片页面

## 职责

`page.tsx` 按请求读取演示用户的卡片，交给 `CardManager` 组合界面。
`CardManager.tsx` 承载卡片列表、手动申请恢复、刷新、消费入口与消费弹窗。
`CardChangeDialog.tsx` 展示新增、删除、验证与取消。
`CardConsumeDialog.tsx` 展示单卡消费表单与该卡消费记录。

## 数据来源

`page.tsx` 是异步服务端组件并带 `export const dynamic = 'force-dynamic'`，服务端用 `banking.card.getCards(demoUserId)` 投影 `CardView[]`，作为 `CardManager` 的初始 props，故首屏 HTML 已含 `CardTile` 的关联账户与余额行，e2e 不必等客户端 fetch 即可断言。
客户端刷新只走 `GET /api/cards` 与 `GET /api/cards/changes`，只采用最新请求序号的响应。
`CardManager` 首帧 `refreshing=true`、`loaded=false`，`disabled = busy || refreshing || !loaded`，故刷新请求返回前入口按钮全为 disabled；断言按钮可用性必须等这两个请求完成。
本页没有授信额度汇总头：页头只有 `pages.cards.summary`（`{count} 张卡片 · 额度与状态`）的卡片计数；`信用额度` 只出现在新增/审阅弹窗（`CardChangeDialog.tsx`），信用卡可用总额汇总在 `/overview` 的 `AssetSummaryCard`。
消费弹窗打开时只单独请求 `GET /api/cards/[id]/consumptions`，不在整页重复请求消费记录。

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

所有接口的请求用户由服务端注入，客户端不得发送 userId。

## 命令边界

卡片新增与删除是模拟记录管理，只在页面办理，助手不能调用。
冻结、解冻、挂失、补卡与分类限额调整走独立工具策略。
虚拟卡申请与挂失卡补办可由助手发起，与其他敏感操作一样需要确认和验证码。
手动申请使用 security/manual-card-management.ts：服务端要求 RED 验证、所有权检查与强制审计。

## CardView 原样直传

`CardView` 由服务端投影，页面层不挑字段、不补默认值。
`linkedAccountStatus` 为 `MISSING`/`UNTRUSTED` 时账号与余额字段整体缺失，界面绝不补 0，也不兜底成默认账户。
`linkedAccountName`、`linkedAccountNumber`、`accountAvailableBalance`、`payableAmount` 只在 `LINKED` 时出现。
关联账户、账户余额、可用余额与不可用提示的唯一渲染处是 `components/banking/CardTile`；本目录只传 `card` 与 `footer`。
页面层只读 `usable` 与 `linkedAccountStatus`，用于决定入口按钮、弹窗提示与表单可用态。

## 消费弹窗

摘要 `data-card-consume-summary` 只读 DTO 字符串字段，不做任何客户端计算，金额一律交给 `Money` 渲染。
关联账户行优先 `linkedAccountName`，并保留 `linkedAccountNumber`（font-mono）。
账户余额行读 `accountAvailableBalance`，可用余额行读 `payableAmount`，月限额行读 `monthlyLimit`。
不可用原因块位于摘要之前并使用 `role="status"`：卡片不可用时按 FROZEN/LOST/其它给提示，关联缺失或不可信时给对应提示。
卡片不可用只禁用提交（入口按钮、`fieldset disabled`、`submit` 守卫、提交按钮 `disabled`），余额与限额摘要照常展示。
入账时间归服务端所有；请求体只含 `amount`、可选 `category`/`merchant` 与 `executionKey`，含 `occurredAt` 会被 400 `VALIDATION` 拒绝。
消费请求由服务端注入 userId；表单不接收真实卡号、支付凭据或密码。
消费失败按错误码映射提示：资金不足、超出月限额、卡片不可消费或通用失败；VALIDATION 拒绝时展示服务端返回的原因。
忙碌状态阻止重复提交与关闭弹窗。

## 幂等

每次消费尝试按“卡片 + 金额 + 分类 + 商户”生成 `executionKey`，重试同一尝试复用，成功后重新生成。
手动申请按输入签名生成 `requestId`，网络重试保留原标识。
验证与取消使用持久化申请标识；关闭弹窗不等于取消已保存申请。
手动申请不混入助手的待确认操作恢复。

## 测试

相关 HTTP 测试在 `tests/app/card-consume-http.test.ts`、`tests/app/manual-card-management.test.ts` 与 `tests/app/card-freeze-audit-http.test.ts`。
e2e 场景在 `tests/e2e/live-virtual-card.e2e-helper.ts` 与 `tests/e2e/card-management.e2e-helper.ts`。
本目录只读这些测试，不修改测试文件；e2e 断言 `p[role="alert"]`，故不可用原因块不得改用 `role="alert"`。
金额展示规则见 [financial-values.md](../../docs/cn/financial-values.md)。
测试钩子：data-card-consume（入口）、data-card-consume-dialog、data-card-consume-card-id、data-card-consume-summary、data-card-consume-form、data-card-consumptions、data-card-consumption（记录行）、data-card-id（单个卡片容器）。
消费相关 e2e 断言以 data-card-* 钩子定位，改动这些属性名会破坏 tests/e2e 下的场景。
`POST /api/cards/[id]/consume` 拒绝任何携带 `occurredAt` 的请求体（400 `VALIDATION`）：入账时间归服务端所有，界面不发送该字段，也不要补充任何客户端时间。
手动卡片验证是本目录唯一自带错误码的 MFA 面：`security/manual-card-management.ts` 熔断时抛 `AppError('CIRCUIT_OPEN')`，`_lib/http.ts` 映射为 HTTP 423 失败信封，`CardManager.tsx` 84-100 行据此把申请置为 `locked` 并显示 `pages.cards.locked`。
同一处检查的 `'LOCKED'` 不在 `ErrorCode`（`lib/errors.ts:1`）里，服务端不可能返回，属不可达分支。
助手侧 `POST /api/actions/[id]/verify` 是 200 `ok:false` + `status:'locked'`、信封无 `code`，故这套按码提示无法复用于操作卡片。
