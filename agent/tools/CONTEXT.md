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
Its params are `{ cardId }` only, with no per-type gating: the replacement inherits the source type
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

### `redeem_investment` 赎回本金参数（全额 / 部分）

`redeemAmount` 是可选的本金部分（CNY 十进制字符串）：省略或等于持仓本金表示**全额赎回**（持仓结清、一次性到账）；填入严格小于本金的正数表示**部分赎回**（持仓保留、本金减少，仅按同一估值规则到账该部分的结算金额，剩余本金与市值留在持仓上）。它是普通金额参数——`plan-parameters.ts` 依据 TypeBox 模式校验字符串格式与显式类型后原样转发给 SDK，超额、非正或格式非法的取值由 SDK 以 `VALIDATION` 拒绝，参数层不重复判定金额域。成功摘要按 `InvestResult.partial` 与 `redeemedPrincipal` / `remainingPrincipal` 渲染全额或部分赎回措辞。

### `subscribe_investment` 申购聚合

对已持有产品的重复申购由 SDK 聚合进现有 `HOLDING`：增加该持仓本金并重算市值，`InvestResult.addedToExisting = true`，不新建持仓。工具层无需改动——`subscribe_investment` 照常以 `{ productId, amount }` 转发给 `banking.investment.subscribeInvestment`；成功摘要仍按 `InvestResult.amount` 与可选 `newBalance` 渲染。金额始终为精确十进制字符串，计算使用整数最小单位或十进制算术。

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
