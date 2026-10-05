# agent/tools — Registered Banking Tool Registry

## Intent

The **complete and exhaustive capability set** of the agent, as one module per tool family.
Each family module exports, per tool:

1. a `create<Name>Tool(userId: string): AgentTool<typeof <Name>Params>` **factory**
   (`@mariozechner/pi-agent-core`) returning an `AgentTool` whose params are a **TypeBox** schema
   (`Type`/`Static` re-exported by `@mariozechner/pi-ai`) — `execute` calls the Banking SDK and
   returns an `AgentToolResult`, **throwing `AppError`** (`@/lib/errors`) on failure; and
2. a plain `run<X>(userId, args): Promise<ToolExecutionResult>` runner — the model-free path used
   by the registry's `executeDirect`; it **catches** and returns `ToolExecutionResult{ok:false,error}`.

`index.ts` builds a **per-user** registry (`createToolRegistry(userId)`).

This node decides **capability only** — never permission. There is deliberately **no** bash/shell/
write/edit/file/SQL/system/http tool: an injection asking for one has no tool to call. Every tool
the model proposes still passes through the agent's `beforeToolCall` → `security.gateway`, where the
GREEN/YELLOW/RED tier, confirmation and MFA are decided by **code**. See parent `../CONTEXT.md`.

## API Surface

Frozen facade (`index.ts`):

```ts
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolName } from '@/lib/contracts/tools';
import type { RiskLevel } from '@/lib/contracts/risk';

export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  tier?: RiskLevel;
}
/** Additive per-call option accepted by the model-free runners. Only `transfer_money` reads it. */
export interface ToolRunOptions { idempotencyKey?: string; }
export interface ToolRegistry {
  tools: Record<ToolName, AgentTool<any>>;
  list(): AgentTool<any>[];
  get(name: ToolName): AgentTool<any>;
  /** Gateway-authorized execution path: run a tool's args through the SDK WITHOUT the model. */
  executeDirect(name: ToolName, args: Record<string, unknown>, opts?: ToolRunOptions): Promise<ToolExecutionResult>;
}
export const TOOL_NAMES: readonly ToolName[];      // exactly the 26 frozen names
export interface CreateToolRegistryOptions { submitPlan?: SubmitPlanDeps; }
export function createToolRegistry(userId: string, opts?: CreateToolRegistryOptions): ToolRegistry;
```

`AgentTool`'s generic is the TypeBox **schema** (`AgentTool<TParameters extends TSchema, TDetails>`),
so a heterogeneous registry uses `AgentTool<any>` (matching `AgentState.tools: AgentTool<any>[]`);
`AgentTool<unknown>` does not compile.

`opts` is an **additive optional** parameter — one-arg calls match the frozen signature; it exists
only because `submit_plan` needs an injected `sessionId` + gateway-routed `runTool` (see Design
Decisions). `userId` is **closed over** per tool by `createToolRegistry(userId)`; the model never
supplies it.

Per family module: a `create<Name>Tool(userId: string): AgentTool<typeof <Name>Params>` **factory**
(the generic is the TypeBox SCHEMA object, not `Static<>`) and a model-free
`run<Name>(userId: string, args: Record<string, unknown>): Promise<ToolExecutionResult>` runner
(e.g. `createGetBalanceTool` + `runGetBalance`). Param schemas are exported as `<Name>Params` with a
derived `<Name>Args` type. `index.ts`'s `createToolRegistry` calls every factory and assembles the
`Record<ToolName, AgentTool<any>>`.

### Tool catalogue (module → tier → Banking SDK call)

| Tool | Module | Tier | Banking SDK call |
|---|---|---|---|
| `get_balance` | account.ts | 🟢 | `banking.account.getBalance(userId)` |
| `get_transactions` | transaction.ts | 🟢 | `banking.transaction.listTransactions(userId, query)` |
| `detect_anomaly` | transaction.ts | 🟢 | `banking.transaction.detectAnomaly(userId)` |
| `analyze_spending` | analysis.ts | 🟢 | `banking.transaction.analyzeSpending(userId, { month })` |
| `get_dashboard_summary` | dashboard.ts | 🟢 | `banking.dashboard.getDashboardSummary(userId)` |
| `search_contact` | contact.ts | 🟢 | `banking.contact.searchContacts(userId, query)` |
| `get_cards` | card.ts | 🟢 | `banking.card.getCards(userId)` |
| `set_card_limit` | card.ts | 🟡 | `banking.card.setCardLimit({ cardId, category, amount })` |
| `freeze_card` | card.ts | 🟡 | `banking.card.freezeCard(cardId)` |
| `unfreeze_card` | card.ts | 🔴 | `banking.card.unfreezeCard(cardId)` |
| `report_lost_card` | card.ts | 🔴 | `banking.card.reportLostCard(cardId, { reason })` |
| `apply_virtual_card` | card.ts | 🟡 | `banking.card.applyVirtualCard({ userId, label })` |
| `list_subscriptions` | subscription.ts | 🟢 | `banking.subscription.listSubscriptions(userId)` |
| `cancel_subscription` | subscription.ts | 🟡 | `banking.subscription.cancelSubscription(subscriptionId)` |
| `set_subscription_reminder` | subscription.ts | 🟡 | `banking.subscription.setSubscriptionReminder(subscriptionId, remind)` |
| `list_investments` | investment.ts | 🟢 | `banking.investment.listProducts({ riskLevel })` |
| `compare_investments` | investment.ts | 🟢 | `banking.investment.compareInvestments(productIds)` |
| `get_investment_holdings` | investment.ts | 🟢 | `banking.investment.listHoldings(userId)` |
| `subscribe_investment` | investment.ts | 🔴 | `banking.investment.subscribeInvestment({ userId, productId, amount })` |
| `redeem_investment` | investment.ts | 🔴 | `banking.investment.redeemInvestment({ userId, holdingId })` |
| `transfer_money` | transfer.ts | 🟡/🔴 dynamic | `banking.transfer.createTransfer({ userId, ..., idempotencyKey? })` |
| `reserve_budget` | budget.ts | 🟢 | `banking.budget.reserveBudget({ userId, ... })` |
| `list_scheduled_tasks` | task.ts | 🟢 | `banking.task.listScheduledTasks(userId)` |
| `create_scheduled_task` | task.ts | 🟡 | `banking.task.createScheduledTask({ userId, ... })` |
| `change_password` | security.ts | 🔴 | _(none — demo-only; see Design Decisions)_ |
| `submit_plan` | planning.ts | META (not gated) | `planner` `dag.validatePlan`/`buildPlan` + `executor.runPlan` |

Tier legend: 🟢 GREEN auto-executes · 🟡 YELLOW needs confirmation · 🔴 RED needs MFA. Tiers are
**authoritative in `security/permission-engine.ts`**, not here (this table mirrors the root catalogue).

`submit_plan` meta types (planning.ts): `SubmitPlanDeps { sessionId; runTool; onNodeUpdate?; signal?; now? }`,
`PlanRunTool = (toolName: ToolName, args) => Promise<PlanToolOutcome>`, and
`createSubmitPlanTool(userId, deps): AgentTool<typeof SubmitPlanParams>`.

## Constraints

- **Capability only — never gating.** No permission/risk/MFA/daily-limit computation here; that is
  `security/`'s sole authority, enforced in the agent's `beforeToolCall`.
- **`userId` is server-injected.** Tools close over the `userId` from `createToolRegistry(userId)`;
  no tool accepts a `userId` parameter from the model. `banking-sdk` calls take it as the first arg.
- **Exact `ToolName` coverage.** `AgentTool.name` MUST equal the corresponding `ToolName`; the
  registry MUST contain exactly the 26 names in `lib/contracts/tools.ts` — none missing, none extra.
  `TOOL_NAMES` is the single list to assert against; both the tool map and the `executeDirect`
  runner map are typed `Record<ToolName, …>` so a missing tool is a compile error.
- **No shell/file/network tools.** The registered banking tools + `submit_plan` are the complete
  capability set; never add a bash/shell/write/edit/file/SQL/system/http tool.
- **Error strategy.** `execute` THROWS `AppError` on failure (the runtime converts it to an error
  tool-result); `run<X>` CATCHES and returns `ToolExecutionResult{ok:false,error}`. Never swallow,
  never let a raw exception reach the model.
- **Import types, never redeclare.** Cross-module types come from `@/lib/contracts/*`; SDK DTOs from
  `@/banking-sdk`; planner types from `@/planner`. Use the `@/*` alias for cross-node imports and
  `./` within this node.
- **Files ≲ ~1000 lines** — one module per family; split further if a family outgrows it.
- Dependency direction: this node depends on `lib`, `banking-sdk`, `planner` — never the reverse.

## Design Decisions

- **Tools are factories, not module-level constants.** A module-level `const` cannot bind the
  server-injected `userId`, so each family exports `create<Name>Tool(userId)` and
  `createToolRegistry(userId)` calls them — closing `userId` over every tool (never read from args).
- **`submit_plan` needs injected deps.** It runs a DAG whose nodes must route through the gateway,
  so `runSubmitPlan(userId, args, deps)` requires `SubmitPlanDeps` (`sessionId` + gateway-routed
  `runTool`), and `planning.createSubmitPlanTool(userId, deps)` is a factory. Since the model cannot
  supply these, `createToolRegistry` receives them via the additive `opts.submitPlan` (see parent
  `../CONTEXT.md`: the agent passes `runTool = executeGatedTool`). If `opts.submitPlan` is omitted,
  the SDK-backed tools still work and `submit_plan` is still REGISTERED, but its `execute` throws
  (`INTERNAL`) and `executeDirect('submit_plan', …)` returns `{ ok:false, error }` — it is unusable
  without the deps.
- **`change_password` has no Banking SDK function.** The demo `User` model stores no credential and
  the SDK is an execute-only banking surface, so `runChangePassword` returns a simulated success
  view model and the **`AuditLog` entry is the authoritative record** of the change. The tool exists
  to exercise RED gating + MFA + audit.
- **Tools are data + a thin SDK call.** Each family module only declares the TypeBox schema, the
  `AgentTool` object and one runner that forwards to its `banking-sdk` function — no business rules
  (funds/minAmount/recipient resolution are SDK concerns).
- **`transfer_money` carries an optional at-most-once key.** Its runner takes `opts?: ToolRunOptions` and forwards `opts.idempotencyKey` verbatim as the SDK `TransferInput.idempotencyKey`; the SDK derives the ledger row id as `idempotentTransferTxId(userId, key)` (`@/lib/ledger`) and reuses it as the PK, so a repeat replays the original `Transaction` row instead of double-debiting (the created id is surfaced as `TransferResult.transactionId`). `confirmation.ts` supplies the gated action's `PendingAction.id` as the key. The `AgentTool.execute` (model path) passes NO key; the gated transfer is executed model-free via `executeDirect`.

## Dependencies

Frozen imports (exist; DO NOT redefine): `../lib/contracts/tools` (`ToolName`), `../lib/contracts/risk`
(`RiskLevel`), `../lib/contracts/task` (`TaskNodeSpec`, `TaskNodeResult`), `../lib/errors` (`AppError`).
Pi SDK: `AgentTool` (`@mariozechner/pi-agent-core`), `Type`/`Static` (`@mariozechner/pi-ai`).

Sibling nodes consumed (read-only; escalate changes to the owner):
- `../banking-sdk` → `banking.{account,transaction,transfer,contact,card,subscription,investment,budget,task,dashboard}.*`
  (execute-only domain functions; DTOs in `banking-sdk/types.ts`).
- `../planner` → `dag.validatePlan`, `dag.buildPlan`, `executor.runPlan`, `PlanToolOutcome`.
- `../security` → the gateway that gates these tools (consumed by the agent, not this node).

## Test Strategy

Vitest (via `../tests`, sibling). Determinism: no network — unit tests stub `../banking-sdk` (and
`../planner` for `submit_plan`), so the stubs can be driven without Prisma.

- **Registry contract:** `createToolRegistry(userId).tools` keys set === `TOOL_NAMES` set ===
  the `ToolName` union (assert all 26, none extra); every `AgentTool.name` matches its key;
  `list()`/`get()` consistent with `tools`.
- **`executeDirect` dispatch:** one case per tool — assert it routes to the right family runner and
  maps a thrown `AppError` to `ToolExecutionResult{ok:false,error}`.
- **Param schemas:** each `<ToolName>Params` validates the documented shape and rejects a missing
  required field.
- **`userId` injection:** assert `userId` is passed to the SDK stub and is never read from `args`;
  a `args.userId` supplied by the model is ignored.
- **`submit_plan`:** `runSubmitPlan` validates the DAG (`deps.runTool` NOT called on invalid input)
  and parks a gated node (`requiresConfirmation`) via the injected `runTool`. Without `opts.submitPlan`,
  `submit_plan` is still registered but `executeDirect` returns `{ ok:false, error }`.
- Full-pipeline demo scenarios run against these tools in `../tests` with `LLM_MODE=mock`.

## Routing Table

- `./agent/tools/account.ts` → `get_balance`
- `./agent/tools/transaction.ts` → `get_transactions`, `detect_anomaly`
- `./agent/tools/analysis.ts` → `analyze_spending`
- `./agent/tools/dashboard.ts` → `get_dashboard_summary`
- `./agent/tools/contact.ts` → `search_contact`
- `./agent/tools/card.ts` → `get_cards`, `set_card_limit`, `freeze_card`, `unfreeze_card`, `report_lost_card`, `apply_virtual_card`
- `./agent/tools/subscription.ts` → `list_subscriptions`, `cancel_subscription`, `set_subscription_reminder`
- `./agent/tools/investment.ts` → `list_investments`, `compare_investments`, `get_investment_holdings`, `subscribe_investment`, `redeem_investment`
- `./agent/tools/transfer.ts` → `transfer_money`
- `./agent/tools/budget.ts` → `reserve_budget`
- `./agent/tools/task.ts` → `list_scheduled_tasks`, `create_scheduled_task`
- `./agent/tools/security.ts` → `change_password`
- `./agent/tools/planning.ts` → `submit_plan` (meta) + `SubmitPlanDeps`/`createSubmitPlanTool`
- `./agent/tools/index.ts` → registry facade: `createToolRegistry`, `ToolExecutionResult`, `ToolRegistry`, `TOOL_NAMES`
- `../agent` → Pi Agent runtime that installs `beforeToolCall` and calls these tools (parent — read-only)
- `../banking-sdk` → SDK functions each tool forwards to (sibling — read-only, escalate writes to owner)
- `../planner` → DAG validate/build/run backing `submit_plan` (sibling — read-only, escalate writes to owner)
- `../lib/contracts` → frozen `ToolName`/`RiskLevel`/task types this node imports (sibling — read-only)
