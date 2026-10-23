# 安全状态展示

`PermissionLegend` 展示权限分级说明。
`SecurityEventList` 展示服务端安全事件。
`CircuitBreakerStatus` 展示锁定与失败次数。

这些组件使用 `useI18n`，属于客户端叶子组件。
数据来自属性，不在组件中查询或更新安全状态。
解锁请求由 `app/security` 的操作组件负责。

本目录只有三个组件与一个同名索引：`index.ts` 原样再导出三者，无默认导出。
本目录不渲染任何金额：不导入 `Money`/`DecimalMoney`，也不读取待确认操作的事实字段
（赎回快照、费用基数、费率规则），因此手续费、管理费、赎回费一类数量概念不在此展示；
它们的展示属于对话回执与结果卡片。
本目录用到的 `security.*` 文案位于 `lib/i18n/messages/business.zh-CN.json`
（`security.breaker.*`、`security.permissions.*`、`security.events.*`、`security.events.kind.*`），
不在 `pages.*.json`（只有 `pages.*`）或 `app.*.json`（只有 `app.*`/`ui.*`/`transport.*`）中。

`SecurityEventList` 的事件正文先经 `lib/public-text.ts` 的 `isInternalDiagnostic` 判定：
内部诊断或空正文替换为按 `event.kind` 取到的 `security.events.kind.*` 标签，
因此 `__SECURITY_BLOCK__` 载荷、原始 JSON 与堆栈不会进入 DOM。
组件内不做字符串清洗，判定规则只在 `lib/public-text.ts`。
该替换是幂等的：上游已投影过的事件再经过一次仍得到同一结果。

安全事件的严重程度不等于业务权限等级。
事件列表也不是完整的成功验证记录。
不得根据颜色推断交易是否执行。

权限和解锁规则见
[security/CONTEXT.md](../../security/CONTEXT.md)。
安全中心入口见
[app/security/CONTEXT.md](../../app/security/CONTEXT.md)。
