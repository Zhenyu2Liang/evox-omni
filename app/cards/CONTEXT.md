# 卡片页面

## 职责

`page.tsx` 按请求读取演示用户的卡片，交给 `CardManager` 组合界面。
`CardManager.tsx` 承载卡片列表、手动申请恢复、刷新、消费入口与消费弹窗。
`CardChangeDialog.tsx` 展示新增、删除、验证与取消。
`CardConsumeDialog.tsx` 展示单卡消费表单与该卡消费记录。

## 数据来源

服务端用 `banking.card.getCards(demoUserId)` 投影 `CardView[]`，作为 `CardManager` 的初始 props。
客户端刷新只走 `GET /api/cards` 与 `GET /api/cards/changes`，只采用最新请求序号的响应。
消费弹窗打开时只单独请求 `GET /api/cards/[id]/consumptions`，不在整页重复请求消费记录。

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
