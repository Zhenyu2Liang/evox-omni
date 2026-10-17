# 卡片 HTTP 边界

## 职责

`app/api/cards` 是卡片相关的 HTTP 边缘：卡片读取、虚拟卡消费与消费流水、手动演示卡片的增删提案及
MFA 验证/取消。每个路由只做「校验入参 → 解析服务端身份 → 委派领域模块 → 序列化冻结信封」。

资金计算、月限额判定、卡片与账户所有权、MFA 挑战、审计一律留在所属模块：

- `@/banking-sdk`（`banking.card.*`）：读模型、消费扣款、消费流水查询；
- `@/security/manual-card-management`：手动卡片提案、验证、取消与该命令的审计。

身份始终在服务端解析：读接口用 `_lib/session#resolveUserId`，命令接口用 `_lib/session#requireIdentity`
（固定演示工作区）。Cookie、查询参数或请求体都不能选择用户、会话或他人资源。共享传输设施只来自
`_lib`（`http`、`session`、`schemas`、`types`），本目录不新增并行辅助函数。

## API Surface

| 路由 | 文件 | 契约 |
| --- | --- | --- |
| `GET /api/cards` | `route.ts` | 无查询参数；返回 `{ ok: true, data: { cards: CardView[] } }`（SDK 读模型）。 |
| `POST /api/cards` | `route.ts` | 手动新增演示卡片提案（`addDemoCardSchema`，`.strict()`）；返回 `CardChangeResponse`，需后续 MFA 验证才落库。 |
| `DELETE /api/cards/[id]` | `[id]/route.ts` | 手动删除演示卡片提案（`deleteDemoCardSchema`，`.strict()`）；路径 `id` 由服务端拼入，不接受请求体中的卡片标识。 |
| `POST /api/cards/[id]/consume` | `[id]/consume/route.ts` | 请求体 `{ amount, category?, merchant?, executionKey? }`；`amount` 为精确 CNY 十进制字符串；记账时间由服务端决定。返回 `ConsumeCardResult`。 |
| `GET /api/cards/[id]/consumptions` | `[id]/consumptions/route.ts` | 可选 `?limit=`（1–500，共享 `limitQuerySchema`）；返回 `{ ok: true, data: { consumptions: CardConsumptionView[] } }`，最新在前。 |
| `GET /api/cards/changes` | `changes/route.ts` | 当前工作区仍未完成的卡片变更列表（`CardChange[]`）。 |
| `POST /api/cards/changes/[id]/verify` | `changes/[id]/verify/route.ts` | 请求体 `{ code }`（`verifyCardChangeSchema`，`.strict()`）；返回 `CardChangeResponse`。 |
| `POST /api/cards/changes/[id]/cancel` | `changes/[id]/cancel/route.ts` | 无请求体；取消未执行的卡片变更，返回 `CardChangeResponse`。 |

信封：成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message } }`。
HTTP 状态由 `_lib/http#errorResponse` 的冻结映射决定（`VALIDATION` → 400、`NOT_FOUND` → 404、
`SECURITY_DENIED` → 403、`CONFLICT` → 409、`LIMIT_EXCEEDED`／`INSUFFICIENT_FUNDS` → 422、
`CIRCUIT_OPEN` → 423）。SDK 消费拒绝走错误信封；手动卡片命令的领域结果（如错误验证码）是正常
HTTP 200 且 `CardChangeResponse.ok === false`。

## 服务端拥有记账时间

消费的记账时间完全由服务端决定：`banking.card.consumeCard` 按业务时钟（`demoNow()`）入账，
月限额按服务端所处的业务月归属，因此不存在任何客户端时间参数，客户端也无法把某笔消费挪到别的
月份以规避当月限额。

`POST /api/cards/[id]/consume` 的请求体**只要出现** `occurredAt` 键（过去、未来、字符串、数字、
`null` 或格式错误的值一律相同）就以 `AppError('VALIDATION')`（HTTP 400）拒绝，检测发生在路由私有的
`parseConsumeBody`（在原始请求体上判断键是否存在，再交给共享 `parseBody` 校验）。拒绝在委派 SDK 之前
发生，因此不会产生任何持久化副作用（无资金变动、无流水行、无 `CardConsumption` 行）。只有「键不存在」
才被接受。

## 约束

- 服务端拥有时间：路由不得从请求体、查询参数或请求头读取记账/生效/限额归属时间，也不得添加任何
  时间参数；客户端送来这类键时必须显式拒绝，不能静默剥离。
- 身份来自 `_lib/session`，所有权由 SDK（或 `security/manual-card-management`）在事务内校验；
  路由内不重复实现授权或资金逻辑。
- 请求体 schema 保持模块私有：路由模块只导出 HTTP 处理函数、路由配置和 TypeScript 类型。
- 动态参数为异步接口，读取方式为 `(await ctx.params).id`（`_lib/types#IdRouteContext`）；
  子目录到 `_lib` 的相对路径按层级计算（如 `../../../_lib/http`）。
- 路由不导入 Prisma 客户端或执行模块；缓存、恢复与重放语义属于领域模块。

## 给后续代理的说明

- 新增卡片写端点时复用 `_lib/http` 的解析与信封函数；需要拒绝某个服务端拥有字段时，在路由私有的
  解析函数里先读原始请求体判断键是否存在（参考 `[id]/consume/route.ts` 的 `parseConsumeBody`），
  不要把该逻辑降级成「解析后删除该键」——静默剥离会接受请求并隐藏伪造意图。若第二个端点需要同一
  保证，再把这段读取原始请求体的逻辑上提到 `_lib/http`（例如 `parseBodyRejectingKeys`）。
- `occurredAt` 的拒绝消息是契约的一部分：`Consumption time is server-owned: 'occurredAt' must not be sent`。
  文案会随 400 响应返回给客户端。
- 手动卡片三个 schema（新增、删除、验证码）均为 `.strict()`，因此多余键（含任何时间字段）本身就会
  `VALIDATION` 失败——这是卡片变更端点不存在同类时间伪造口的原因，不要放宽为 `.passthrough()`。
- 路由传给 `banking.card.consumeCard` 的入参只有 `userId`、`cardId`、`amount`、`category`、`merchant`
  与 `executionKey`：路由与 SDK 之间不传递任何时间字段，其他入口也不得提供记账时间。

## 测试策略

- `tests/app/card-consume-http.test.ts`：真实路由处理器进程内驱动 `POST /api/cards/[id]/consume`
  与 `GET /api/cards/[id]/consumptions`（SQLite + SDK 全链路），覆盖扣款落库、`executionKey` 重放、
  身份提示无效、各种领域拒绝以及 `occurredAt` 拒绝契约。
- `tests/app/card-freeze-audit-http.test.ts`：卡片状态变更的授权与审计覆盖（经 `/api/actions/*`），
  用于确认卡片端点不绕过确认、MFA 与审计。
- 上述测试由其他代理维护，本目录只读。测试进程共享一个 SQLite 库且不得并行；测试与构建输出写入
  `logs/`（如 `pnpm exec vitest run tests/app 2>&1 | Tee-Object logs/api-cards-test.txt`）。
