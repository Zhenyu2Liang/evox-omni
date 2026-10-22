# 页面与 HTTP 边界

## 职责

页面读取数据并组合界面。
API 校验输入、调用领域模块并序列化结果。
业务权限、资金计算与恢复逻辑保留在所属模块。

当前使用 Next.js 16、React 19 与 Tailwind CSS 4。
修改框架代码前，必须阅读本地 Next.js 指南。
动态参数与 Cookie 按异步接口读取。
运行包的服务端配置见 `next.config.mjs`。

## 页面入口

| 路径 | 用途 |
| --- | --- |
| `/`、`/agent` | 默认跳转与智能助手 |
| `/overview` | 资产概览 |
| `/bills` | 月度账单与异常记录 |
| `/contacts`、`/cards` | 联系人与手动卡片管理 |
| `/investments`、`/subscriptions` | 理财与订阅 |
| `/schedules` | 定时记录、通知与到期检查 |
| `/activity`、`/security` | 业务记录与安全状态 |
| `/audit`、`/runs`、`/manual` | 开发者审计、运行与人工接管 |

布局与导航由 `layout.tsx` 和 `_components/` 组合。
普通模式隐藏开发者入口。
开发者偏好不是生产认证。
语言偏好仅影响界面显示。

## 身份与传输

Web 身份与接口表见 [api/CONTEXT.md](api/CONTEXT.md)。
所有浏览器使用服务端配置的同一演示工作区。
对话历史、业务数据与待处理操作在浏览器间共享。

服务端页面通过 SDK、审计模块或仓储读取数据。
客户端通过 API 发出业务请求。
传给客户端的金融值使用精确字符串。

读取数据库的服务端页面按请求渲染。
构建需要已生成的 Prisma 客户端。
构建前不必重置或播种开发库。

## 对话渲染边界

`/agent` 页面只把服务端快照传给 `components/chat/ChatWindow`。
确认/MFA 面板、工具事件与失败文案（含 `chat.error.*` 键）全部在 `components/chat/` 渲染。
`app/` 不筛选、不清洗 `AgentStreamEvent`：`api/chat/route.ts` 的 SSE 帧与 `api/actions/[id]/verify/route.ts` 的 `events` 都原样转发。
排查聊天文案、`security_event` 或面板显隐时进入 `components/chat/`，不要在 `app/` 内继续搜索。
`app/` 对 `PendingAction` 只读：仅 `agent/history.ts` 与 `agent/plan-history.ts` 直接查询该表，写入（含 `status`）全部经 `@/agent`、`@/security` 与 `lib/db/repositories/pendingAction.ts` 完成。
因此本层没有把 `locked` 行改回 `pending`/`awaiting_mfa` 的路径，锁定与否只看仓储与网关。

## 修改约束

- 客户端不得导入数据库客户端或业务执行模块。
- HTTP 错误与 SSE 格式必须复用 `api/_lib/http.ts`。
- 确认结果必须采用服务端返回的业务状态。
- 页面职责变化时，必须更新对应子目录说明。

界面规则见 [components/CONTEXT.md](../components/CONTEXT.md)。
开发和测试命令见 [development.md](../docs/cn/development.md)。
