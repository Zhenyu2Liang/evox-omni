# 微信通道

`pi-weixinbot@1.0.5` 协议模块负责扫码、长轮询和回复。
`banking-client.ts` 只调用本机银行 HTTP API，不导入业务 SDK。
`bridge.ts` 只接受扫码绑定用户的完整文字私聊。
消息串行处理，稳定消息键绑定银行 requestId，outbox 在发送前保存。
确认、验证码和取消为显式命令，操作编号必须已由本通道展示。
验证码不进入模型和本地消息正文。
本地 state.json 含凭据，目录被 Git 忽略；不得输出原文。
`worker.ts` 在整个消息批次处理完成后提交游标。
`scripts/weixin.ts` 管理登录、运行、状态和本地退出。
操作和测试边界见 `docs/cn/weixin.md`。
