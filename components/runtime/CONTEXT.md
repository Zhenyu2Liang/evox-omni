# 运行记录展示

## 职责

`RunHistory.tsx` 是运行记录页的唯一客户端组件（`'use client'`），用于检视持久化的执行元数据与已落地事件。
它只读取服务端已投影的只读数据，不触发任何资金写入，也不渲染原始模型推理。

## API Surface

- 导出：`RunHistory` 无 props 组件。
- 使用的 HTTP 端点（均 `credentials: 'same-origin'`、`cache: 'no-store'`）：
  - `GET /api/runs` → `{ runs: RunListItem[] }`
  - `GET /api/runs/:id` → `AgentRunSummary`（`@/agent/durable/service`）
  - `GET /api/runs/:id/events?after=<seq>&limit=100` → `RuntimeEventPage`（`@/lib/contracts/runtime`）
  - `POST /api/runs/:id/recover`（空 JSON body）→ `RunRecoveryResponse`
- 统一响应包络：`{ ok: boolean; data: T; error?: { message: string } }`；`fetch` 非 2xx 或 `ok === false` 均抛错。

## 展示结构

左侧运行列表（状态文案、开始时间、调用/事件计数、等宽 run id）；
右侧详情（状态、可恢复时的「恢复」按钮、调用表、事件流）。
调用表有四列：工具序号+名、调用状态、重放策略、`attempt/maxAttempts`。
事件流为 `max-h-96` 可滚动有序列表，每条显示 `#sequence eventType` 与原样 JSON payload。

## 文案与本地化

- 所有固定文案走 `useI18n()` 的 `t()`，键集中在 `runs.*` 命名空间（`runs.title`、`runs.description`、`runs.status.<status>`、`runs.invocation.<status>`、`runs.replay.<replaySafety>`、`runs.count`、`runs.recover`、`runs.empty`、`runs.select`、`runs.loadMore`、`runs.checkNew`、`runs.list`、`runs.details`，刷新按钮复用 `tasks.approvals.refresh`）。
- 动态枚举值用 `label(key, fallback)`：`isMessageKey(key) ? t(key) : fallback`，未知状态回退原始字符串。
- 错误同样走 `label(error, error)`：错误串若恰为消息键则翻译，否则原样显示。
- 时间用 `new Date(startedAt).toLocaleString(locale)`，跟随语言 cookie。

## 约束

- 不输出 `data-testid`；仅用 `aria-label`（`runs.list`/`runs.details`）与 `role="alert"`／`role="status"` 标记区域。
- 恢复按钮只在 `detail.status` ∈ `interrupted`/`failed`/`waiting_confirmation`/`waiting_verification` 时出现；该状态清单硬编码在组件里，与 `agent/durable` 新增状态不同步会静默缺失入口。
- 事件 payload 直接 `JSON.stringify(..., null, 2)` 渲染，不做 `isInternalDiagnostic` 过滤或字段白名单；展示的是原始事件结构而非业务结果，因此任何业务字段（金额、费用等）只作为事件 JSON 的一部分透明出现，组件自身不解释、不格式化、不校验。
- 组件不读 Prisma、不调用服务端执行函数，全部数据来自上述只读接口。

## 提示

节点目前只有这一个文件，无子目录、无桶文件（`index.ts`），导入路径直接写 `@/components/runtime/RunHistory`。
