/**
 * card-emitter.ts — the CONTRACT mapping a tool's raw result → `ChatCard`(s).
 * `toCards` is PURE and TOTAL: one case per banking tool family, mapping `ToolExecutionResult` to the
 * `ChatCard` union (balance/transfer/spending/cards/investments/subscriptions/anomaly/plan/error).
 * Unrecognised tool or malformed result ⇒ a single `error` card. Cards are the ONLY way tool data
 * reaches the UI — model prose is never turned into a card.
 *
 * Payload shapes follow the binding consumer, `components/chat/cards/CardRenderer.tsx` +
 * the card components' props (the frozen `ChatCard.data` is `unknown`, so the renderer is the contract):
 *   balance → `BalanceView` · transfer → `TransferResult` · spending → `SpendingAnalysis`
 *   cards → `CardView[]` · investments → `{ products?; holdings?; comparison? }`
 *   subscriptions → `SubscriptionView[]` · anomaly → `AnomalyReport` · plan → `TaskPlan`
 * All DTOs come from `@/banking-sdk` (`banking-sdk/types.ts`).
 */
import type { ChatCard } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolExecutionResult } from './tools';

const DEFAULT_FAILURE_MESSAGE = '工具执行失败';

/** A non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalise a DTO payload that may be a single object or a list into a list. Returns `null` when the
 * value is neither (a malformed / missing payload).
 */
function toDtoList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return [value];
  return null;
}

function isEveryRecord(list: readonly unknown[]): boolean {
  return list.every(isRecord);
}

/** A single `error` card naming the tool whose payload could not be recognised. */
function malformed(toolName: ToolName): ChatCard {
  return errorCard(`工具 ${toolName} 返回了无法识别的数据`);
}

/* ------------------------------------------------------------------ shape guards */

/** `BalanceView` discriminator: the account list is an array. */
function isBalanceView(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.accounts);
}
/** `TransferResult` discriminator: a boolean `success` flag. */
function isTransferResult(value: unknown): boolean {
  return isRecord(value) && typeof value.success === 'boolean';
}
/** `SpendingAnalysis` discriminator: category breakdown is an array. */
function isSpendingAnalysis(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.byCategory);
}
/** `AnomalyReport` discriminator: the anomaly list is an array. */
function isAnomalyReport(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.anomalies);
}
/** `TaskPlan` discriminator: a `goal` string and a `nodes` array. */
function isTaskPlan(value: unknown): value is TaskPlan {
  return isRecord(value) && typeof value.goal === 'string' && Array.isArray(value.nodes);
}

/* ------------------------------------------------------------------------- toCards */

/** Map a tool result to zero or more chat cards. PURE + total (unknown ⇒ [{type:'error'}]). */
export function toCards(toolName: ToolName, result: ToolExecutionResult): ChatCard[] {
  // A failed tool never yields a data card — its failure is surfaced as an error card.
  if (result.ok !== true) {
    const message =
      result.error !== undefined && result.error !== '' ? result.error : DEFAULT_FAILURE_MESSAGE;
    return [errorCard(message)];
  }

  const data = result.data;

  switch (toolName) {
    case 'get_balance':
      return isBalanceView(data) ? [{ type: 'balance', data }] : [malformed(toolName)];

    case 'transfer_money':
      return isTransferResult(data) ? [{ type: 'transfer', data }] : [malformed(toolName)];

    case 'analyze_spending':
      return isSpendingAnalysis(data) ? [{ type: 'spending', data }] : [malformed(toolName)];

    case 'detect_anomaly':
      return isAnomalyReport(data) ? [{ type: 'anomaly', data }] : [malformed(toolName)];

    // Card family — reads return `CardView[]`, mutations a single updated `CardView`.
    case 'get_cards':
    case 'set_card_limit':
    case 'freeze_card':
    case 'unfreeze_card':
    case 'report_lost_card':
    case 'apply_virtual_card': {
      const cards = toDtoList(data);
      return cards !== null && isEveryRecord(cards)
        ? [{ type: 'cards', data: cards }]
        : [malformed(toolName)];
    }

    // Subscription family — `SubscriptionView[]` (or a single updated `SubscriptionView`).
    case 'list_subscriptions':
    case 'cancel_subscription':
    case 'set_subscription_reminder': {
      const subscriptions = toDtoList(data);
      return subscriptions !== null && isEveryRecord(subscriptions)
        ? [{ type: 'subscriptions', data: subscriptions }]
        : [malformed(toolName)];
    }

    // Investment family — `InvestmentsCardData` fills exactly one field per read.
    case 'list_investments': {
      const products = toDtoList(data);
      return products !== null && isEveryRecord(products)
        ? [{ type: 'investments', data: { products } }]
        : [malformed(toolName)];
    }
    case 'get_investment_holdings': {
      const holdings = toDtoList(data);
      return holdings !== null && isEveryRecord(holdings)
        ? [{ type: 'investments', data: { holdings } }]
        : [malformed(toolName)];
    }
    case 'compare_investments': {
      if (!isRecord(data)) return [malformed(toolName)];
      const products = Array.isArray(data.products) ? data.products : undefined;
      return [{ type: 'investments', data: { comparison: data, products } }];
    }

    // Planner meta-tool — the run result carries the assembled DAG.
    case 'submit_plan':
      return isTaskPlan(data) ? [{ type: 'plan', plan: data }] : [malformed(toolName)];

    // Known tools with NO dedicated variant in the frozen `ChatCard` union: emit no card. Their
    // outcome is still conveyed by the assistant message + the `ToolEventView` timeline entry.
    case 'get_transactions':
    case 'search_contact':
    case 'get_dashboard_summary':
    case 'list_scheduled_tasks':
    case 'create_scheduled_task':
    case 'reserve_budget':
    case 'subscribe_investment':
    case 'redeem_investment':
    case 'change_password':
      return [];

    // Runtime-unknown tool name (the `ToolName` union cannot reach here) — fail safe, never throw.
    default:
      return [errorCard(`未知工具：${String(toolName)}`)];
  }
}

/** A standalone error card. PURE. */
export function errorCard(message: string): ChatCard {
  return { type: 'error', message };
}

/** A confirmation card from a pending-action summary. PURE. */
export function confirmationCard(action: PendingActionSummary): ChatCard {
  return { type: 'confirmation', action };
}

/** An MFA-required card. PURE. */
export function mfaCard(actionId: string, hint?: string): ChatCard {
  return hint === undefined ? { type: 'mfa', actionId } : { type: 'mfa', actionId, hint };
}
