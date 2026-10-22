# 外部消息通道（非 Web）

## Intent

把外部 IM 协议接到本机银行 HTTP API 上。通道本身没有 SDK 写入能力：身份、授权、MFA、熔断、回执和模型续接全部复用 Web 入口，通道只负责协议收发与文字投影。

## API Surface

- `weixin/`：pi-weixinbot 协议传输、扫码绑定、去重 outbox、显式命令面与公开文字投影。详细契约见 `channels/weixin/CONTEXT.md` 与 `docs/cn/weixin.md`。

## Constraints

- 通道内不导入 `banking-sdk`，只经本机 HTTP API 读写；`weixin/config.ts` 强制只允许 localhost 银行地址。
- 面向用户的文本只能经 `lib/public-text.ts`（`isInternalDiagnostic` / `safePublicText` / `securityNotice`）收口；原始工具参数、节点 output、`__SECURITY_BLOCK__` 载荷、堆栈和 `undefined` 不得上屏。
- 安全拒绝只按 `ActionResult.status`、`code`、`failure` 的类型化字段渲染，禁止文案匹配。
- 验证码只存在单次 HTTP 请求体内，不写本地 state、不进模型、不在日志回显。

## Routing Table

- `weixin/`：微信通道全部实现（`transport.ts` 协议、`bridge.ts` 消息路由与结算回复、`commands.ts` 命令面、`presentation.ts` 卡片投影、`banking-client.ts` HTTP 客户端与事件渲染、`state.ts` 持久化、`worker.ts` 轮询、`login.ts` 扫码、`config.ts` 端点校验）；无更深子目录。
