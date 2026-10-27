/**
 * card-emitter.ts — the CONTRACT mapping a tool's raw result → `ChatCard`(s).
 * `toCards` is PURE and TOTAL: one case per banking tool family, mapping `ToolExecutionResult` to the
 * `ChatCard` union, including public query results and validated business receipts.
 * Unrecognised tool or malformed result ⇒ a single `error` card. Cards are the ONLY way tool data
 * reaches the UI — model prose is never turned into a card.
 *
 * Payload shapes follow the binding consumer, `components/chat/cards/CardRenderer.tsx` +
 * the card components' props (the frozen `ChatCard.data` is `unknown`, so the renderer is the contract):
 *   balance → `BalanceView` · transfer → `TransferResult` · spending → `SpendingAnalysis`
 *   cards → `CardView[]` · investments → `{ products?; holdings?; comparison? }` (each holding carries
 *   the SDK's own 净值 + 份额 facts verbatim — `shares`, `latestNetValue`, `latestNetValueDate`,
 *   `marketValue`, `profit`, `profitRate`, `realizedProfit`, `cumulativeProfit`, `valueBasis`)
 *   subscriptions → `SubscriptionView[]` · anomaly → `AnomalyReport` · plan → `TaskPlan`
 * An investment WRITE projects its validated receipt AND, when the write re-read its positions after
 * committing, an `investments` card carrying those CURRENT holdings — so a completed subscription or
 * redemption never leaves a pre-write holding snapshot as the newest position card.
 * Dedicated business-result payloads are validated and projected by `business-card-payloads.ts`.
 * No model prose or tool arguments are treated as financial result evidence.
 */
import type { ChatCard } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolExecutionResult } from './tools';
import { budgetPayload, contactPayload, dashboardPayload, investmentPayload, scheduledPayload } from './business-card-payloads';

const DEFAULT_FAILURE_MESSAGE = 'The banking operation failed.';
const INVALID_RESULT_MESSAGE = 'The banking result could not be displayed. Refresh the saved records to check the outcome.';

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

/** Keep raw diagnostic names out of ordinary business result cards. */
function malformed(_toolName: ToolName): ChatCard {
  return errorCard(INVALID_RESULT_MESSAGE);
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
/** Exact positive CNY text with two decimals (`12.00`); floats and rounded values are never evidence. */
function isExactMoney(value: unknown): boolean {
  return typeof value === 'string' && /^\d+\.\d{2}$/.test(value);
}
/** `TaskPlan` discriminator: a `goal` string and a `nodes` array. */
function isTaskPlan(value: unknown): value is TaskPlan {
  return isRecord(value) && typeof value.goal === 'string' && Array.isArray(value.nodes);
}

/**
 * The `HoldingView[]` an investment write re-read after committing (`agent/tools/investment.ts`
 * `withHoldings`). `null` means the result carries no usable snapshot — the write is still committed,
 * so the caller projects only its receipt instead of inventing a position list.
 */
function writtenHoldings(data: unknown): unknown[] | null {
  if (!isRecord(data)) return null;
  const holdings = data.holdings;
  if (!Array.isArray(holdings) || !isEveryRecord(holdings)) return null;
  return holdings;
}

/* ------------------------------------------------------------------------- toCards */

/** Map a tool result to zero or more chat cards. PURE + total (unknown ⇒ [{type:'error'}]). */
export function toCards(toolName: ToolName, result: ToolExecutionResult, actionId?: string): ChatCard[] {
  // Historical quotations support prose and are never banking result cards.
  if (toolName === 'search_conversation_history') return [];
  // A failed tool never yields a data card — its failure is surfaced as an error card.
  if (result.ok !== true) {
    const message =
      result.error !== undefined && result.error !== '' ? result.error : DEFAULT_FAILURE_MESSAGE;
    return [errorCard(message, result.errorCode)];
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
    case 'replace_card':
    case 'apply_virtual_card': {
      const cards = toDtoList(data);
      return cards !== null && isEveryRecord(cards)
        ? [{ type: 'cards', data: cards, ...((toolName === 'replace_card' || toolName === 'apply_virtual_card') && actionId
          ? { issuanceActionId: actionId } : {}) }]
        : [malformed(toolName)];
    }

    // Card spend — `{ consumption, card, accountAvailableBalance }`: the enriched `CardView` is the
    // visible server evidence, so one `cards` card (the existing union member) is its faithful mapping.
    case 'consume_virtual_card': {
      if (!isRecord(data)) return [malformed(toolName)];
      const { consumption, card } = data;
      return isRecord(consumption) && isExactMoney(consumption.amount) && isRecord(card)
        ? [{ type: 'cards', data: [card] }]
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

    // Investment family — `InvestmentsCardData` fills exactly one field per read. The write cases at
    // the end of this switch project the receipt PLUS the positions the write just re-read.
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

    case 'get_transactions':
      return Array.isArray(data) ? [{ type: 'transactions', data }] : [malformed(toolName)];
    case 'search_contact': {
      const contacts = contactPayload(data);
      return contacts === null ? [malformed(toolName)] : [{ type: 'contacts', data: contacts }];
    }
    case 'get_dashboard_summary': {
      const dashboard = dashboardPayload(data);
      return dashboard === null ? [malformed(toolName)] : [{ type: 'dashboard', data: dashboard }];
    }
    case 'list_scheduled_tasks':
    case 'create_scheduled_task': {
      const tasks = scheduledPayload(data);
      return tasks === null ? [malformed(toolName)] : [{ type: 'scheduled', data: tasks, created: toolName === 'create_scheduled_task' }];
    }
    case 'reserve_budget': {
      const receipt = budgetPayload(data);
      return receipt === null ? [malformed(toolName)] : [{ type: 'receipt', data: receipt }];
    }
    case 'subscribe_investment':
    case 'redeem_investment': {
      const receipt = investmentPayload(data, toolName === 'subscribe_investment' ? 'investmentPurchase' : 'investmentRedemption');
      if (receipt === null) return [malformed(toolName)];
      // The receipt is the authoritative outcome of the committed write; the positions it re-read
      // follow it as the SAME `investments` payload `get_investment_holdings` produces, so the newest
      // position card is the post-write state (an empty list renders the honest "no holdings" state).
      // A missing snapshot projects the receipt alone: the write already happened, so it can never add
      // an error card and never invents a holding list.
      const holdings = writtenHoldings(data);
      return holdings === null ? [{ type: 'receipt', data: receipt }]
        : [{ type: 'receipt', data: receipt }, { type: 'investments', data: { holdings } }];
    }
    // Runtime-unknown tool name (the `ToolName` union cannot reach here) — fail safe, never throw.
    default:
      return [errorCard(INVALID_RESULT_MESSAGE)];
  }
}

/** A standalone error card. PURE. */
export function errorCard(message: string, code?: import('@/lib/errors').ErrorCode): ChatCard {
  return { type: 'error', message, ...(code ? { code } : {}) };
}

/** A confirmation card from a pending-action summary. PURE. */
export function confirmationCard(action: PendingActionSummary): ChatCard {
  return { type: 'confirmation', action };
}

/** An MFA-required card. PURE. */
export function mfaCard(actionId: string, hint?: string, action?: PendingActionSummary): ChatCard {
  return { type: 'mfa', actionId, ...(hint === undefined ? {} : { hint }), ...(action ? { action } : {}) };
}
