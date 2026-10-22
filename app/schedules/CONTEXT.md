# 定时任务与提醒页

## 职责

`/schedules` 页面是客户端组件（`'use client'`），只做读取与触发，不含业务权限或资金逻辑。
数据来自 `GET /api/schedules`（任务与已送达提醒）与 `POST /api/schedules/tick`（检查到期任务）。
页面只提交请求、渲染列表与错误提示；到期门控、付款流程与提醒投递都属于服务端。

## 渲染收口契约

所有服务端文本与异常文本（`task.dispatchError`、`notification.message`、页面级错误）必须先经
`public-task-text.ts` 的 `publicScheduleText(text, t, fallback)`：

- 非字符串、空白、或 `isInternalDiagnostic` 命中时，回落既有 catalog 键；
- 文本本身是消息键时按当前语言本地化（保留服务端返回键名的既有行为）；
- 其余合法业务散文原样渲染，例如 `付款流程未创建：账户不可用`。

闸门只有 `isInternalDiagnostic`，不使用 `safePublicText`：后者套用 `publicToolError` 白名单，
会把合法的派发错误替换成兜底文案。诊断判定与正则属于 `@/lib/public-text`，此处不得复制。
状态/类型枚举展示仍用本地 `label` 键。

## 依赖

`@/lib/public-text`（诊断判定）、`@/lib/i18n/shared`（`MessageKey`、`Translator`、`isMessageKey`）、
`@/lib/i18n/LocaleProvider`、`@/components/ui`、`@/lib/date`、`@/lib/contracts/schedule`。

## 已知边界

提醒正文损坏或缺失时没有专用键，复用 `tasks.schedules.emptyNotifications`（暂无已送达提醒）作为兜底，
文案略偏离「单条提醒不可用」的语义。页面没有渲染级断言测试，验证依赖纯模块单测与接口测试。
