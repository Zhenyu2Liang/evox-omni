# Banking tool definitions and results

## Responsibility

This directory defines banking capabilities, parameter schemas, SDK runners, and their Pi result adapters.
It does not authorize financial operations. The agent routes calls through the security gateway;
the gateway decides confirmation, MFA, ownership, financial limits, and execution rights.

The model cannot provide `userId`, session identity, an idempotency key, or an execution fence.
The server binds these values in `createToolRegistry(userId, options)` and trusted execution options.
There are no shell, file, SQL, arbitrary HTTP, or credential-change tools.

## Source files

| File | Responsibility |
|---|---|
| `index.ts` | Build owner-bound definitions; validate and dispatch `executeDirect`; apply trusted write context. |
| `plan-parameters.ts` | Validate original direct-call and workflow parameters without implicit coercion. |
| `result.ts` | Convert typed results into native Pi success or `isError: true`; project public model data. |
| `planning.ts` | Persist and execute a validated workflow through injected gateway and claim ports. |
| `plan-compiler.ts` | Validate declared scope, node structure, output references, and dependencies. |
| Family modules | Export TypeBox schemas, factories, and model-free SDK runners. |

`lib/contracts/tool-catalog.ts` is the source of capability names, effects, authorization defaults,
agent availability, and replay policy. Use `AGENT_TOOL_NAMES` for model-visible capabilities and
`TOOL_NAMES` for the complete catalog. Do not maintain a separate hard-coded capability count.

## Agent capabilities

| Capability | Module | Authorization |
|---|---|---|
| `get_balance` | `account.ts` | GREEN read |
| `get_transactions`, `detect_anomaly` | `transaction.ts` | GREEN read |
| `analyze_spending` | `analysis.ts` | GREEN read |
| `get_dashboard_summary` | `dashboard.ts` | GREEN read |
| `search_contact` | `contact.ts` | GREEN read |
| `search_conversation_history` | `conversation-history.ts` | GREEN historical read |
| `get_cards` | `card.ts` | GREEN read |
| `set_card_limit` | `card.ts` | YELLOW write |
| `freeze_card`, `unfreeze_card`, `report_lost_card` | `card.ts` | RED write |
| `list_subscriptions` | `subscription.ts` | YELLOW read |
| `cancel_subscription`, `set_subscription_reminder` | `subscription.ts` | YELLOW write |
| `list_investments`, `compare_investments`, `get_investment_holdings` | `investment.ts` | GREEN read |
| `subscribe_investment`, `redeem_investment` | `investment.ts` | RED write |
| `transfer_money` | `transfer.ts` | Dynamic amount and daily-total policy |
| `reserve_budget` | `budget.ts` | GREEN budget-envelope write |
| `list_scheduled_tasks` | `task.ts` | GREEN read |
| `create_scheduled_task` | `task.ts` | YELLOW scheduled-intent write |
| `submit_plan` | `planning.ts` | Workflow submission; each node is gated independently |

GREEN runs automatically, YELLOW requires confirmation, and RED also requires strong verification.
A budget envelope is bookkeeping; it does not debit or freeze account funds.
Creating a scheduled intent does not preauthorize a future financial write.
Card creation and deletion use the manual card-management page. The catalog entry `apply_virtual_card`
is disabled for the agent and rejects agent calls; it is never offered to the model.

`describe_turn` lives in `turn-intent.ts` and records model-declared conversational purpose.
It is an internal control tool, not a banking capability or customer authorization.

### `redeem_investment` 赎回本金参数（全额 / 部分）

`redeemAmount` 是可选的本金部分（CNY 十进制字符串）：省略或等于持仓本金表示**全额赎回**（持仓结清、一次性到账）；填入严格小于本金的正数表示**部分赎回**（持仓保留、本金减少，仅按同一估值规则到账该部分的结算金额，剩余本金与市值留在持仓上）。它是普通金额参数——`plan-parameters.ts` 依据 TypeBox 模式校验字符串格式与显式类型后原样转发给 SDK，超额、非正或格式非法的取值由 SDK 以 `VALIDATION` 拒绝，参数层不重复判定金额域。成功摘要按 `InvestResult.partial` 与 `redeemedPrincipal` / `remainingPrincipal` 渲染全额或部分赎回措辞。

### `subscribe_investment` 申购聚合

对已持有产品的重复申购由 SDK 聚合进现有 `HOLDING`：增加该持仓本金并重算市值，`InvestResult.addedToExisting = true`，不新建持仓。工具层无需改动——`subscribe_investment` 照常以 `{ productId, amount }` 转发给 `banking.investment.subscribeInvestment`；成功摘要仍按 `InvestResult.amount` 与可选 `newBalance` 渲染。金额始终为精确十进制字符串，计算使用整数最小单位或十进制算术。

## Parameters and SDK errors

Every family exports `<Name>Params`, `<Name>Args`, `create<Name>Tool`, and `run<Name>`.
Factories bind trusted identity. Runners return `ToolExecutionResult`; SDK domain failures are
converted by `toolFailure` into `errorCode`, a public message, and approved candidate details.

The registry validates unknown fields, explicit types, and financial domains before dispatch.
Both direct calls and workflow nodes use the same parameter validation. Monetary amounts are
exact decimal strings; financial calculations use integer minor units or decimal arithmetic.
Invalid optional input fails instead of silently becoming an absent filter or a default value.

Transaction filters use integer epoch milliseconds and a half-open `[from, to)` range.
`get_transactions` defaults to the newest 50 rows and accepts a limit from 1 to 200.
Its totals cover returned rows only; `analyze_spending` provides complete monthly consumption.
Month labels use `YYYY-MM`, interpreted in the banking business time zone.

Empty search results are successful reads. Missing or foreign selected resources fail with
`NOT_FOUND`. Malformed parameters use `VALIDATION`; ambiguous selection uses `CONFLICT` and
safe candidate details. Ownership and permission failures must not become an empty successful write.
Anomaly flags are screening observations, not evidence that a transaction was fraudulent.

## Data sent to Pi

Use `toModelToolResult` for every factory result. Pi sends `content` to the model; `details` alone
does not supply the model with structured banking evidence.

- Success content contains the summary and a JSON object with public structured data.
- Failure content contains the server-owned `bankingError` envelope and native `isError: true`.
  The envelope carries the domain code, safe message, next action, and available failed-outcome data.
- Raw infrastructure exceptions do not become model instructions or public error text.
- Model projections remove server identities and execution keys, mask phone numbers, and preserve
  business resource IDs, exact financial values, and complete result text.
- UI and journal details retain the structured result. Public chat cards apply their own validated
  projections; ordinary users do not see internal execution keys or raw tool parameters.

Historical conversation quotations preserve original wording. They do not prove bank execution
or grant consent to resume a write. Archive searches require a trusted session and owner.

## Durable execution

| Operation | Recovery rule |
|---|---|
| Completed read | Reuse recorded output when recovering the same invocation; do not rerun to invent a new observation. |
| Interrupted GREEN read | Retry only under the catalog's read policy and current owned run lease. |
| Gated read | Preserve its authorization and source request; recovery does not bypass confirmation. |
| Write | Use a server-owned execution identity, atomic business write and receipt, and execution fence. Verify saved outcome before retry. |
| Unknown write outcome | Reconcile recorded state; never retry from model prose or error wording. |
| Workflow | Reacquire owned execution claims and resume stored nodes; completed nodes keep their results and identities. |

`ToolRunOptions.idempotencyKey` is supplied by the runtime, not tool arguments.
Plan-node and confirmed-action identities remain stable on replay. SDK fences run inside the write
transaction and roll back the effect if execution rights have expired, moved, or been cancelled.
Idempotency prevents duplicate effects; it does not grant permission.

## Verification

Use pure tests for schemas, typed error adapters, public data projection, and parameter boundaries.
Use isolated database tests for ownership, exact balances, atomic receipts, independent MFA,
workflow claims, and process-crash recovery. Full-pipeline tests must use the real registry and
gateway rather than assuming a family runner has already been authorized.

Developer documentation is maintained under `docs/cn/`. For the parent runtime and durable
recovery implementation, read `agent/CONTEXT.md` and the modules under `agent/durable/`.
