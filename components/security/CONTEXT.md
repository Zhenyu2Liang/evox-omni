# 安全状态展示

`PermissionLegend` 展示权限分级说明。
`SecurityEventList` 展示服务端安全事件。
`CircuitBreakerStatus` 展示锁定与失败次数。

这些组件使用 `useI18n`，属于客户端叶子组件。
数据来自属性，不在组件中查询或更新安全状态。
解锁请求由 `app/security` 的操作组件负责。

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
