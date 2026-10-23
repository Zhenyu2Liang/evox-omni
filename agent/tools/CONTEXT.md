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
| `money-schema.ts`, `decimal-schema.ts` | Exact parameter text: CNY money (2dp), investment shares (6dp) and net value per unit (4dp) canonical decimal schemas. |
| `result.ts` | Convert typed results into native Pi success or `isError: true`; project public model data. |
| `planning.ts` | Persist and execute a validated workflow through injected gateway and claim ports. |
| `plan-compiler.ts` | Validate declared scope, node structure, output references, and dependencies. |
| Family modules | Export TypeBox schemas, factories, and model-free SDK runners. |

Workflow parameter descriptions distinguish success dependencies from user-requested business conditions. Decimal/money condition thresholds use exact decimal strings, including zero; count thresholds use numbers. A zero spending result is still a successful query and must not create an invented positive-spend condition.

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
| `freeze_card`, `unfreeze_card`, `report_lost_card`, `replace_card`, `apply_virtual_card`, `consume_virtual_card` | `card.ts` | RED write |
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
Brand-new physical card creation and card deletion are manual-only on the Cards page and expose no
agent capability; the Cards page has no 补办 action.
`replace_card` is an ordinary agent capability for ANY owned `LOST` card — DEBIT, CREDIT or VIRTUAL.
Its params carry the shared card selectors (`cardSelectorFields`, see below) with no per-type gating: the replacement inherits the source type
and network (a CREDIT replacement inherits `creditLimitMinor`/`availableLimitMinor`; a VIRTUAL
replacement keeps its linked settlement account and the month-continuous family allowance), the
source card stays `LOST` and records `replacedByCardId`, and a repeat call on the same source returns
the same replacement instead of issuing a second one.
The tool's model-visible `description` states this coverage explicitly.
Virtual card issuance is an agent capability (`apply_virtual_card`).
This directory exposes exactly ONE card-spend write, `consume_virtual_card` (RED): it spends an
exact CNY amount from an owned ACCOUNT-BOUND virtual card by debiting that card's linked CHECKING
settlement account through `banking.card.consumeCard` (atomic sufficient-funds debit plus a
`channel='CARD'` ledger row and a `CardConsumption` row in ONE transaction, guarded by the card's
monthly limit, replayable by execution key).
Virtual-card consumption booking time is SERVER-OWNED: the business clock (UTC+08:00) fixes both the
booking time and the monthly-limit window, so the tool schema carries no date/time argument,
and `rejectClientSuppliedTime` (`card.ts`) refuses ANY caller-supplied time field (`occurredAt`,
`occurredTime`, `occurred_at`, `bookedAt`, `bookingTime`, `timestamp`, `time`, `date`,
`occurredDate`) with a `VALIDATION` error carrying 消费入账时间由服务端决定. That guard throws before
`banking.card.consumeCard`, so a forged time writes nothing — no debit, no `channel='CARD'` ledger
row, no `CardConsumption` row — and is never silently dropped. `plan-parameters.ts` runs the same
guard for `consume_virtual_card` before the generic unexpected-key check, so a model-supplied date
fails with that reason instead of `Unsupported parameters`. The success summary reports only the
server-returned facts: consumption amount and merchant, the card's masked number, 关联账户,
绑定账户可用余额, 月消费限额 (or `未设置月限额` when the card has none) and 当前可支付金额.
Card reads and analysis (`get_cards`, `analyze_spending`, `get_transactions`,
`get_dashboard_summary`) never debit.

## Card target selectors

`cardSelectorFields()` in `card.ts` defines one optional selector set shared by every card-target
write: `set_card_limit`, `freeze_card`, `unfreeze_card`, `consume_virtual_card`, `report_lost_card`
and `replace_card` (the gateway's `CARD_TARGET_TOOLS`). `get_cards` and `apply_virtual_card` carry no
selector: one is a read, the other creates a new card.

- `cardId` is an exact id from `get_cards` and is never interpreted as anything else. A tail or a
  complete card number placed here is REFUSED (`invalid`), never re-looked-up as a selector, so a
  misplaced tail cannot hit an arbitrary card.
- `cardType` accepts `DEBIT`/`CREDIT`/`VIRTUAL` (case-insensitive) or 借记卡/储蓄卡/信用卡/虚拟卡.
- `cardTail` accepts exactly four trailing digits, written as `6688`, `尾号6688`, `****6688` or `...6688`.
- `cardNumber` accepts a complete 12–19 digit number (spaces or dashes allowed) and matches only by
  exact equality with the server-only `Card.numberFull`, so a card with a NULL `numberFull` cannot be
  selected this way.

Supplied selectors combine: every one must hit the SAME owned card.
`security/card-resolution.ts#resolveCardTarget` resolves them at park time into four statuses
(`resolved`/`not_found`/`ambiguous`/`invalid`); a multi-candidate result must be clarified and lists
masked candidates only. A resolved target is canonicalized to `cardId` (`canonicalizeCardArgs`
deletes `cardType`/`cardTail`/`cardNumber`), so the confirmation summary and the SDK act on the same
card. `cardTargetId(userId, args)` is the runner-side fallback: a canonical `cardId` passes through,
selectors-only args go through the same resolver, and an unresolved target throws `VALIDATION` with
the masked clarification. Model-facing descriptions must steer 尾号6688 to `cardTail` and 我的借记卡
to `cardType`. See `docs/cn/identity-resolution.md`.
A `clarify` refusal never opens a `PendingAction`: `security/security-gateway.ts:1628-1635` returns
the plain Chinese sentence as `blockReason` (no `BLOCK_REASON_PREFIX` payload), so
`agent/turns/events.ts:63-69` publishes a `status:'error'` tool event whose `summary` IS that verbatim
clarification and whose `errorCode` is absent. The rendered error card is NOT that text:
`lib/tool-feedback.ts:50-68` `publicToolError` allow-lists only exact business messages plus a few
closed regexes, so `buildCardClarifyMessage`/`buildRecipientClarifyMessage` output falls through to the
generic `chat.error.toolFailed`. Assert on the tool event's `status`/`summary`, never on card copy.

`describe_turn` lives in `turn-intent.ts` and records model-declared conversational purpose.
It is an internal control tool, not a banking capability or customer authorization.
It has NO entry in `lib/contracts/tool-catalog.ts`, so it is absent from `TOOL_CATALOG`/`TOOL_NAMES`/`AGENT_TOOL_NAMES`
and from `createToolRegistry` entirely (`tools`, `runners`, `list()`, `get()`, `executeDirect` never know it).
Registration is separate: `agent/banking-agent.ts` builds it with `createTurnIntentTool(readTurnIntent, write)`
and injects it FIRST into the Pi tool list (`tools: [intentTool, ...registry.list()]`), so the model sees it
alongside the banking tools. `beforeToolCall` returns `undefined` for `TURN_INTENT_TOOL` before identity/
parameter validation and before the security gateway, so it is never gated and never creates a `PendingAction`.
Its schema is `{ purpose: 'conversation'|'advice'|'query'|'operation'; operations: string[]; allowProtocolExamples?: boolean; workflow?: boolean }`;
`execute` delegates to `../intent-context.ts#declareConversationIntent` (VALIDATION/CONFLICT for unregistered or
side-effecting operations, purpose changes and sequence changes) and returns `authorized: false`.
Other literal `'describe_turn'` couplings: `agent/turns/events.ts` drops its start/update/end events from the UI
stream, `agent/durable/retry-policy.ts` gives it `read_only`/3 attempts, and `agent/durable/control-recovery.ts`
replays its recorded model call. The stored intent shape is `ConversationIntent` in `lib/contracts/intent.ts`.

### `redeem_investment` 赎回口径（`mode`：SHARES / AMOUNT / ALL）

`RedeemInvestmentParams` = `{ holdingId, mode, shares?, amount?, expectedShares?, expectedNetValue?, expectedNetValueDate?, expectedSettlementAmount? }`。`mode` **必填**，取值 `SHARES | AMOUNT | ALL`，没有默认口径：`SHARES` 必须给 `shares`、`AMOUNT` 必须给 `amount`（由 SDK 按最新净值折算份额）、`ALL` 全部赎回且不接受份额或金额。口径的判定点在工具层 `investment.ts#redemptionRequest()`，先于任何 SDK 调用：口径缺失或未知、混用（`SHARES`+`amount`、`AMOUNT`+`shares`、`ALL`+任一）都返回 `VALIDATION`，口径缺失时话术固定为 `赎回需要明确口径：请确认按「份额」还是按「金额」赎回`。因此「赎回 2000」这类只给金额、未说明口径的请求必须回到澄清，绝不会被读成本金并在其上再额外支付收益。

`redeemAmount`（旧「赎回本金」口径）及其别名 `expectedRedemptionAmount` **不是**参数：`plan-parameters.ts` 把它们当未知参数拒绝，`redemptionRequest()` 另以同一澄清话术（detail `PRINCIPAL_MODE_RETIRED`）在 SDK 之前拒绝。`InvestResult.redeemedPrincipal` / `remainingPrincipal` 仍作为只读结果回退字段参与摘要渲染，它们不是请求参数。

`shares` / `expectedShares` 与 `expectedNetValue` 使用 `decimal-schema.ts` 的 `SharesParameter`（≤6 位小数）与 `NetValueParameter`（≤4 位小数）：无符号纯十进制文本，拒绝负号、指数、货币符号和 JS number，多余小数位被拒（模式层给 `The call contains invalid tool parameters`，`canonical*` 给 `份额/净值最多允许 N 位小数`）。写库前一律经 `canonicalShareCount` / `canonicalNetValue`（内部 `decimalText()`）规范化，因为 SDK 的 `recordedShares()` / `productNetValue()` 要求 `nonNegativeDecimal(raw) === raw`：`'5050.000000'` → `'5050'`、`'0.9880'` → `'0.988'`。`amount` / `expectedSettlementAmount` 走 `money-schema.ts` 后规范成两位小数。

`expectedShares` / `expectedNetValue` / `expectedNetValueDate`（净值业务日，UTC epoch 毫秒整数）/ `expectedSettlementAmount` 是 `security/security-gateway.ts#redemptionSnapshot` 铸造的授权快照，由 `approvedSnapshot()` 规范化后原样转发，使 SDK 能在写事务内比对陈旧授权。执行身份不由模型提供：`runRedeemInvestment` 只把 `opts.idempotencyKey` 转发为 `idempotencyKey`，schema 里没有 `executionKey`。

`redemptionSummary()` 只用服务端返回值渲染：赎回口径、赎回份额、成交净值（含 UTC+08:00 净值日期）、预计到账、费用口径（`SIMULATED_NONE` → `模拟环境不收取赎回费，赎回费 ¥0.00`）、剩余份额（0 时标注「持仓已结清」）、剩余成本、已实现收益、可选账户余额，末尾附 `收益为模拟估算，不承诺保本。`；缺失字段写「历史数据不足」，本地不用浮点重算任何金额。

`get_investment_holdings` 的每条持仓渲染七项事实：持仓份额、最新净值与净值日期、持仓市值、剩余持仓成本、持仓收益、持仓收益率、累计收益。市值、收益、收益率取自 SDK（市值恒为 `shares × latestNetValue`，收益率只是把 SDK 的无量纲比率乘 100 的展示换算），记录无法支撑的项显式输出「历史数据不足」而不伪造数字；`valueBasis: 'MIGRATED_ESTIMATE'` 追加「（估算）」。

### `subscribe_investment` 申购聚合

对已持有产品的重复申购由 SDK 聚合进现有 `HOLDING`：增加该持仓份额与本金并重算市值，`InvestResult.addedToExisting = true`，不新建持仓。工具层以 `{ productId, amount }`（金额规范成两位小数）转发给 `banking.investment.subscribeInvestment`，并把 `opts.idempotencyKey` 转发为执行身份。申购结果本身不带成交净值，`runSubscribeInvestment` 因此以一次只读的 `banking.investment.listHoldings()` 回读该持仓最近一笔 `purchases[].netValuePerUnit` / `netValueDate` 作为**展示**用成交净值；这次回读失败或被重放的旧记录没有该字段时，摘要写「历史数据不足」，绝不把已成交的申购判为失败或凭空补一个净值。摘要字段为已认购金额、持仓号、`申购份额`、`成交净值`（含净值日期）、`持仓总份额`、可选账户余额，末尾附 `收益为模拟估算，不承诺保本。`。金额始终为精确十进制字符串，计算使用整数最小单位或十进制算术。

### 写入后的持仓卡（`data.holdings`）

`subscribe_investment` 与 `redeem_investment` 在写事务提交后都调用 `investment.ts#currentHoldings()` 重读 `banking.investment.listHoldings(userId)`，再用 `withHoldings()` 把这份**当前**持仓以 `data.holdings` 附加在权威 `InvestResult` 之上（`amount`/`shares`/`realizedProfit` 等字段语义与取值不变，只是新增一个展示字段）。`agent/card-emitter.ts#writtenHoldings` 因此对这两个写工具投影 `receipt` + `investments`（`{ holdings }`）两张卡：回执仍是写入的权威结论，紧随其后的持仓卡与 `get_investment_holdings` 的形状完全相同，所以聊天里最新一张持仓卡永远是本次写入后的真实状态，绝不会停在写入前的旧快照。回读失败或不返回数组时 `data.holdings` 整体缺失，只投影回执卡——写入已提交，事实优先，绝不把成功写入变成失败调用，也不伪造空持仓；重放时重读的是「现在」的真实持仓。

## `planning.ts` entry points

| Export | Line | Kind / signature |
|---|---|---|
| `SUBMIT_PLAN_TOOL_NAME = 'submit_plan' as const satisfies ToolName` | `:105` | name constant |
| `SubmitPlanParams` / `SubmitPlanArgs` | `:111` / `:131` | TypeBox `{ goal, nodes[] }` |
| `createSubmitPlanTool(userId: string, deps: SubmitPlanDeps): AgentTool<typeof SubmitPlanParams>` | `:185` | factory for the `submit_plan` TOOL |
| `preflightRequestedPlan(userId: string, args: Record<string, unknown>, request: string, intent?: ConversationIntent): Promise<TaskNodeSpec[]>` | `:215` | plain library function (throws, no `ToolExecutionResult`): `compileRequestedPlan` + `validatePlanParameters` + selector/recipient/holding canonicalization |
| `runSubmitPlan(userId: string, args: Record<string, unknown>, deps: SubmitPlanDeps, source?: { runId: string; parentInvocationId: string }): Promise<ToolExecutionResult>` | `:240` | plain library function = the model-free runner behind `executeDirect('submit_plan')` and the `execute` of the tool |
| `type PlanRunTool` / `interface SubmitPlanDeps` | `:68` / `:75` | injected ports: `sessionId`, gateway-routed `runTool`, `runtimeFence`, `invocationIdentity`, `userRequest`, `conversationIntent`, `onNodeUpdate`, `onPlanUpdate`, `signal`, `now` |

`submit_plan` is the only planner-family model-visible capability and is META (`effect: 'workflow'`): it is not risk-gated itself, every money-moving node is gated through `deps.runTool`.
`runSubmitPlan` order: preflight (`:261`) → `dag.validatePlan(nodes, knownTools)` with TWO args (`:265`) → mint the durable rows inside `prisma.$transaction` (`:281-283` `deps.runtimeFence` + `createTaskGraph`, ids adopted at `:286-288` so `plan.id === AgentTask.id`) → claim the plan's executor slot `claimTaskExecutionWithGeneration` (`:329`; a lost claim returns `{ ok:false, error:'计划已在执行中' }` and runs nothing) → `clearStaleNodeClaims` (`:344`) → `buildNodeClaimPorts` (`:353`) → `executor.runPlan` (`:357-386`) with `isRunOwner`, `controls: defaultPollControls(plan.id)`, `claimNode`/`releaseNode` and `createTaskPersistence` → `sweepCancelledPlan` (`:393`) → `releaseTaskExecution` in `finally` (`:395`).
A `'running'` result after `runPlan` means the claim was taken over; the durable status/generation is re-read (`:404-412`) and this run's own node results are kept.

## Registry (`index.ts`)

`createToolRegistry(userId: string, opts?: CreateToolRegistryOptions): ToolRegistry` (`:237`) is the ONLY entry point — there is no module-level `TOOLS`/`toolCatalog` export.
`CreateToolRegistryOptions` = `{ sessionId?, automaticWriteFence?, automaticWriteAudit?, operationIdentity?, submitPlan? }` (`:188-198`).
`ToolRegistry` (`:171-185`) = `{ tools: Record<ToolName, AgentTool<any>>; list(): AgentTool<any>[]; get(name: ToolName): AgentTool<any>; executeDirect(name: ToolName, args: Record<string, unknown>, opts?: ToolRunOptions): Promise<ToolExecutionResult> }`.
`list()` maps the re-exported `AGENT_TOOL_NAMES` (`:26`) onto `tools`; `get(name)` THROWS `AppError('SECURITY_DENIED')` for a non-catalog name and for `catalogEntry(name).agentEnabled === false`, while `executeDirect` returns that same refusal as a value (`:325-336`).
`executeDirect` validates params first (`:348-349`), and for a write tool wraps the runner in `prepareBankingCommand` + `executeBankingCommand` (`:372-381`) so receipts/audit share the transaction.
`submit_plan` is special in three places: dispatched through `runners.submit_plan` (`:312-317`, returns `{ ok:false, errorCode:'INTERNAL' }` without `opts.submitPlan`), `get('submit_plan')` without `opts.submitPlan` returns the throwing placeholder `createUnconfiguredSubmitPlanTool()` (`:208-218`), and the `:388-413` loop adds `prepareArguments` but does NOT replace its `execute` (`:397`) — its own `execute` calls `runSubmitPlan` directly.
So a test that wants the real plan path must build the registry with `{ submitPlan: { sessionId, runTool } }` and then call `registry.executeDirect('submit_plan', args)`.

## Pre-park latency contract

No file in this directory schedules a wall-clock wait: zero `setTimeout`/`setInterval`/`new Promise`/sleep/delay/`AbortSignal.timeout`, zero timeout/TTL constants and zero retry/backoff or `while`/`for(;;)` loops.
`planning.ts:96` declares `signal?: AbortSignal` only to forward `{ signal: deps.signal, now: deps.now }` into `executor.runPlan` (`:385`); it constructs no deadline.
`createToolRegistry` (`index.ts:236-406`) awaits nothing at construction (two literal factory maps + one `for (const name of TOOL_NAMES)` rewrite). Its awaits (`:393` `automaticWriteFence`, `:395` `operationIdentity`) are per call.
`validateBankingParameters`/`validateSchemaParameters` (`plan-parameters.ts:44-80`), `compileRequestedPlan` (`plan-compiler.ts:10-34`) and the `planner/dag.ts` checks are synchronous CPU only.
`preflightRequestedPlan` (`planning.ts:215-238`) executes NO tool and opens no transaction: it compiles, validates parameters, then does at most one unbounded `listHoldings` read (only when a node uses `redeem_investment`) plus one `resolveBankingArgs` read per tool node INSIDE a `Promise.all`. N declared steps therefore cost O(1) sequential DB round trips (1 for a plain multi-write plan, 2 with a redemption, +1 `listContacts` for a transfer), never N.
Every read on that path is unbounded (`lib/banking-selectors.ts:16,20,24,28,37`, `lib/db/repositories/investment.ts:41-47`, `lib/db/repositories/contact.ts:19-24` — no `take`); the bounded read is `get_transactions` (`transaction.ts:47` `limit: query.limit ?? 50`, schema max `MAX_TRANSACTION_READ_LIMIT = 200`).
Unbounded GREEN reads are NOT on the pre-park path because they are model-driven tool executions: `analyze_spending` scans a 6-month window (`banking-sdk/transaction.ts:38` `TREND_MONTHS = 6`, `:72`) and `detect_anomaly` scans the whole history plus an unfiltered-by-take `auditLog.findMany` (`:102`, `:113`).

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

## The per-node `runTool` port: declared here, implemented OUTSIDE

`PlanRunTool` (`planning.ts:68-72`) and the executor's `TaskRunTool` (`agent/workflows/contracts.ts:12`) are the same signature `(toolName, args, {taskId, nodeId}) => Promise<PlanToolOutcome>`; the planner's `PlanToolOutcome` is `planner/executor.ts:37-51`.
`planning.ts` only DECLARES it (`SubmitPlanDeps.runTool`, `:86`) and forwards it inside the claim context (`planning.ts:360-361`). All other plan drivers do the same (`agent/workflows/ports.ts:32-33`, `agent/workflows/action-continuation.ts:42-45`, `agent/confirmation/plan-continuation.ts:42-45`, `agent/scheduled-dispatcher.ts:117-119`).
The production implementation is NOT in this directory: `agent/index.ts:308-325` `taskRunToolFor(sessionId)` resolves the owner from the SESSION row (throwing `SECURITY_DENIED` at `:313` when it cannot) and delegates to `agent/confirmation/gated-execution.ts:107-121` `executeGatedTool` → `:62-104` `executeGatedToolOnce`.
That adapter returns `GatedToolOutcome` (`agent/confirmation/contracts.ts:43-51`), which has NO `failure` and NO `actionStatus` field — only `error` + `errorCode`. So on this path a node's typed `PlanFailure` is produced solely by the planner's own catch (`planner/executor.ts:504-509` `toPlanFailure`), never by the tool layer, and `settleToolNode` (`planner/node-outcome.ts:14-53`) drops `errorCode` entirely: a refused node persists `status:'failed'` + `error` text only (or `waiting_confirmation`/`waiting_verification` + `{pendingActionId}` when the gateway parked it).

## What this directory does NOT own

`agent/tools/` writes NO Prisma `PendingAction`, `AgentTask` or `AgentTaskNode` row directly: the only `prisma` import is `planning.ts:56`, used for `prisma.$transaction` (`:280`) around `createTaskGraph` plus the injected `runtimeFence`. Every other row write goes through injected ports (`claimTaskExecutionWithGeneration`, `releaseTaskExecution`, `clearStaleNodeClaims`, `buildNodeClaimPorts`, `createTaskPersistence`, `sweepCancelledPlan`).
There is NO task-control tool in this directory and none in `lib/contracts/tool-catalog.ts`: no `cancel_task`, `pause_task`, `resume_task`, `retry_task`, no tool taking a `taskId`/`nodeId`/`actionId`.
Plan control and post-parked-node resumption live outside, as plain library functions callable directly from a test:
- `agent/workflows/controls.ts` `pauseTask` (`:18`), `resumeTask` (`:26`), `retryTask` (`:44`) and `agent/workflows/cancellation.ts` `sweepCancelledPlan` (`:47`), `cancelTask` (`:56`), surfaced by `agent/index.ts` and `POST /api/tasks/[id]`;
- `agent/workflows/action-continuation.ts:24` `resumeTaskForAction` → `planner/lifecycle.ts:322` `resumePlan` → `planner/executor.ts:261` `runPlan`. There is NO separate topological continuation: resume == replay `runPlan`, so `submit_plan` is the only fresh-plan driver in this directory.
A cancelled plan's parked actions are revoked only through `sweepCancelledPlan` → `security` gateway `cancelAction` (never a direct status write here).

## Known issues

Declared-write enforcement stays REACTIVE and declaration-gated: `compileRequestedPlan` only runs when `submit_plan` is actually invoked (`planning.ts:261` via `preflightRequestedPlan`), and `requiresDeclaredPlan` (`../intent-context.ts:43`) is called only from `beforeToolCall` (`../banking-agent.ts:289`), which fires on a stray individual write. End-of-turn reconciliation exists only for a write the model DECLARED through `describe_turn` (`../write-continuation.ts:56-62`, live-only): a model that refuses in prose while declaring nothing is never corrected, and no `PendingAction`/panel appears. `card.ts` applies NO card-type gating: `ReplaceCardParams` is `{ cardId }`, and `report_lost_card`/`replace_card` accept DEBIT, CREDIT and VIRTUAL alike (`banking-sdk/card.ts` `replaceCard`).
`planning.ts:265` calls `dag.validatePlan(nodes, knownTools)` with only two args, so output-contract validation is skipped there; the output-contract check runs in `plan-compiler.ts:16` (`BANKING_TOOL_OUTPUTS`).

## Verification

Use pure tests for schemas, typed error adapters, public data projection, and parameter boundaries.
Use isolated database tests for ownership, exact balances, atomic receipts, independent MFA,
workflow claims, and process-crash recovery. Full-pipeline tests must use the real registry and
gateway rather than assuming a family runner has already been authorized.

Developer documentation is maintained under `docs/cn/`. For the parent runtime and durable
recovery implementation, read `agent/CONTEXT.md` and the modules under `agent/durable/`.
