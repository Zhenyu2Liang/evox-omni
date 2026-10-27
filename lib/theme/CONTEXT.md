# 外观偏好

`shared.ts` 定义 `system`、`light`、`dark`，未知值回退为 `system`。
Cookie `banking_theme` 是服务端首次渲染的偏好来源。
`ThemeProvider` 更新 `html[data-theme]` 与 Cookie，通过 `banking-agent:theme` 的 storage 事件同步同浏览器标签页。
不能使用本地存储时，当前页面与 Cookie 保存仍可用。
切换不刷新路由、不重建对话、不发业务请求。

全局调色板在 `app/globals.css`，图表文字使用相同的语义色变量。
`BrandMark` 按显式主题或系统媒体条件选择 Logo 资源。
