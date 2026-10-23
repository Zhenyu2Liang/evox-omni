# 定时任务与提醒

定时任务保存未来意图，到期后由服务端分发。定时付款到期时仍需检查权限。

`/schedules` 显示当前会话的任务和提醒通知。
“检查到期任务”执行 1 轮服务器检查。命令行使用相同分发服务。

## 工具入口

模型用 `create_scheduled_task` 创建任务，用 `list_scheduled_tasks` 读取任务。
`create_scheduled_task` 是 YELLOW 能力，用户确认后才落库。
`list_scheduled_tasks` 是 GREEN 读取，直接返回结果。
取消没有对应的模型工具：`banking-sdk/task.ts` 的 `cancelScheduledTask` 只供服务端调用。
能力与风险等级见 [tool-catalog.ts](../../lib/contracts/tool-catalog.ts)。

时间只由两个参数声明：整数 `runAt`（毫秒时间戳）或 `runAtLocal`。
`runAtLocal` 的格式为 `YYYY-MM-DDTHH:mm[:ss]`，时区固定为 Asia/Shanghai。
缺参数、格式错误、日期不存在、时间已过或两者冲突时，校验以 `VALIDATION` 拒绝。
模型散文里的时间不改变已声明的时间。
规则见 [scheduled-time.ts](../../lib/scheduled-time.ts) 与 [plan-parameters.ts](../../agent/tools/plan-parameters.ts)。

## 到期行为

| 类型 | 到期处理 | 完成依据 |
| --- | --- | --- |
| `REMINDER` | 写入提醒通知 | 通知、审计和任务状态共同提交 |
| `TRANSFER` | 保存原付款工作流，再进入权限网关 | 原工作流的已提交结果 |
| `PAYMENT` | 使用演示转账通道处理付款 | 原工作流的已提交结果 |

当前 `PAYMENT` 没有接入商户支付。
付款重新检查收款人、金额、余额、累计风险和权限。
需要确认或认证时，任务停在 `AWAITING_CONFIRMATION`。
用户在 AI 助手中处理原待授权操作。

保存的 `requiresConfirmation` 不能免除到期权限检查。
该字段由服务端按类型派生：提醒为 `false`，付款与转账为 `true`。
重复分发复用原工作流和原授权，不重复创建付款入口。
后台不会自动推进待确认、待认证或人工暂停的工作流。
到期检查只继续 `pending` 与 `running` 状态的原工作流。
人工复核进行中时，`/确认`、`/验证`、`/取消` 返回领域拒绝。
该拒绝的 `code` 是 `MANUAL_REVIEW_HOLD`，`failure.reason` 是 `manual_review_hold`。
文案只渲染 `chat.error.manualReviewHold`：操作未执行，需从复核收件箱恢复或等待复核结束。
通用“业务状态已变化”文案在这里不成立，因为刷新不解除复核。
已锁定的操作是终态：不再被分发、不再被重试、不会复活。
停等节点一旦结清即被封存，后续检查不再驱动该节点。
重试封存节点会被结构化拒绝：`locked` 返回 `MFA_LOCKED`，其余终态返回 `CONFLICT`。

待人工决定的任务不占新分发容量。后续到期任务仍能分发。
可分发状态只有 `SCHEDULED` 与 `DISPATCHING`，已完成的决策不再占用容量。
默认每个用户与会话范围每轮检查 25 个任务，上限为 100 个任务。

## 任务状态

| 状态 | 含义 |
| --- | --- |
| `SCHEDULED` | 已保存，尚未分发 |
| `DISPATCHING` | 原工作流已保存，正在处理 |
| `AWAITING_CONFIRMATION` | 等待用户确认或认证 |
| `DONE` | 提醒已送达，或付款工作流成功 |
| `FAILED` | 参数、身份或工作流出现明确失败 |
| `CANCELLED` | 已取消未来执行 |

提醒从 `SCHEDULED` 直接进入 `DONE`。
付款通常经过 `DISPATCHING` 和 `AWAITING_CONFIRMATION`。

创建工作流前发生临时基础设施故障时，任务保留 `SCHEDULED`。
系统保存错误，后续检查可以重试。
工作流已启动时，结果与授权继续由原工作流管理。

提醒通知和必需审计在同一事务提交。
审计失败时，事务回滚，后续检查可以重新交付。
通知表的唯一约束阻止同一提醒重复交付。

## 取消与输入边界

尚未分发的意图可以直接取消。
已分发付款必须通过所属计划取消。
取消计划会撤销未执行授权，并保留已提交交易。
存在活动工作流时，银行 SDK 拒绝直接取消定时意图。
取消的判定条件是 `dispatchTaskId` 为空且状态仍为 `SCHEDULED`。

付款参数只接受明确收款人和合法金额。
任意工具名、执行代码和验证码在创建工作流前拒绝。
创建与分发前都调用 [scheduled-command.ts](../../lib/contracts/scheduled-command.ts) 校验这些字段。

## 时钟与会话

公开 HTTP 入口使用真实系统时间。
请求不能提供 `now`、用户 ID 或会话 ID。
服务器使用固定演示身份，并核验任务所属会话。
一个会话不能读取或分发另一个会话的任务。

预置任务可能尚未绑定会话。已认证的页面检查可以建立来源会话绑定。
命令行只遍历已保存来源会话的任务。

演示快进由可信命令行显式指定：

```sh
pnpm scheduler:tick --now '2099-11-20T09:00:00+08:00'
```

调度快进可以触发未来意图。授权与认证仍按真实时间过期。
演示时钟不能延长认证有效期。
创建时的时间校验比较演示时钟：`runAt` 必须晚于 `demoNow()`。
到期分发使用真实时间 `Date.now()`，命令行的 `--now` 只改变分发时钟。
业务日与业务月边界固定为 UTC+08:00（`Asia/Shanghai`）。
安全过期、租约与运维调度使用真实时间。

## 部署入口

每次命令执行 1 轮检查后退出：

```sh
pnpm scheduler:tick
```

进程管理器或外部调度服务可以定期调用命令。
系统未在 Web 服务启动时隐式启动调度循环。
任务的实际执行时间取决于检查频率和处理进程可用性。

## 接口与代码入口

定时任务页展示任务状态和通知。
页面不提供统一的“前往确认”跳转。
待确认的实际银行操作仍保留在原 AI 对话中。
检查到期任务不会代替用户确认或认证。

| 接口或模块 | 职责 |
| --- | --- |
| `GET /api/schedules` | 读取当前会话的任务和最近 100 条通知 |
| `POST /api/schedules/tick` | 接收空对象 `{}`，执行真实时间检查 |
| [分发服务](../../agent/scheduled-dispatcher.ts) | 身份范围、原子分发与工作流状态同步 |
| [命令行入口](../../scripts/scheduler.ts) | 遍历已绑定会话并执行有界检查 |
| `ScheduledTask.dispatchTaskId` | 关联唯一的原付款工作流 |
| `ScheduledNotification.scheduledTaskId` | 通过唯一约束阻止重复通知 |
| [定时任务工具](../../agent/tools/task.ts) | `create_scheduled_task` 与 `list_scheduled_tasks` 的参数与结果 |

生日采购使用预算额度、未来意图和提醒。系统不会实际购买鲜花或蛋糕。
预算额度不冻结可提现资金，定时付款也不提前扣款。

[分发接口测试](../../tests/app/scheduled-dispatch-http.test.ts) 检查并发交付、审计回滚和重新授权。
用例还检查跨会话拒绝、分发后取消和非法载荷。
调度工作流的进程恢复规则见 [持久化与恢复](agent-durability.md)。
