import { validateToolArguments, type JsonObject } from '@earendil-works/pi-ai';
import { AppError } from '@/lib/errors';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { moneyToCents } from '@/lib/money';
import { GetBalanceParams } from './account';
import { AnalyzeSpendingParams } from './analysis';
import { ReserveBudgetParams } from './budget';
import { GetCardsParams, SetCardLimitParams, FreezeCardParams, UnfreezeCardParams, ReportLostCardParams,
  ApplyVirtualCardParams, ConsumeVirtualCardParams, ReplaceCardParams, rejectClientSuppliedTime } from './card';
import { SearchContactParams } from './contact';
import { ConversationHistoryParams } from './conversation-history';
import { GetDashboardSummaryParams } from './dashboard';
import { ListInvestmentsParams, CompareInvestmentsParams, GetInvestmentHoldingsParams, SubscribeInvestmentParams, RedeemInvestmentParams } from './investment';
import { validateScheduledPayload } from '@/lib/contracts/scheduled-command';
import { scheduledTime } from '@/lib/scheduled-time';
import { ListSubscriptionsParams, CancelSubscriptionParams, SetSubscriptionReminderParams } from './subscription';
import { ListScheduledTasksParams, CreateScheduledTaskParams } from './task';
import { GetTransactionsParams, DetectAnomalyParams } from './transaction';
import { TransferMoneyParams } from './transfer';

const parameters = {
  get_balance: GetBalanceParams, analyze_spending: AnalyzeSpendingParams, reserve_budget: ReserveBudgetParams,
  get_cards: GetCardsParams, set_card_limit: SetCardLimitParams, freeze_card: FreezeCardParams,
  unfreeze_card: UnfreezeCardParams, report_lost_card: ReportLostCardParams, search_contact: SearchContactParams,
  apply_virtual_card: ApplyVirtualCardParams, consume_virtual_card: ConsumeVirtualCardParams, replace_card: ReplaceCardParams,
  search_conversation_history: ConversationHistoryParams, get_dashboard_summary: GetDashboardSummaryParams,
  list_investments: ListInvestmentsParams, compare_investments: CompareInvestmentsParams,
  get_investment_holdings: GetInvestmentHoldingsParams, subscribe_investment: SubscribeInvestmentParams,
  redeem_investment: RedeemInvestmentParams,
  list_subscriptions: ListSubscriptionsParams, cancel_subscription: CancelSubscriptionParams,
  set_subscription_reminder: SetSubscriptionReminderParams, list_scheduled_tasks: ListScheduledTasksParams,
  create_scheduled_task: CreateScheduledTaskParams, get_transactions: GetTransactionsParams,
  detect_anomaly: DetectAnomalyParams, transfer_money: TransferMoneyParams,
};

/** Reuse public tool schemas and reject any coercion before a workflow can create effects. */
export function validatePlanParameters(node: TaskNodeSpec): void {
  if (node.kind !== 'tool') return;
  validateBankingParameters(node.tool ?? '', node.args ?? {}, node.id);
}

/** Validate original model parameters before either direct or planned banking effects. */
export function validateBankingParameters(name: string, args: Record<string, unknown>, callId: string): void {
  if (!Object.hasOwn(parameters, name)) throw new AppError('VALIDATION', 'The banking capability has no parameter schema.');
  // 消费入账时间由服务端业务时钟决定：卡消费的时间字段在通用的未知参数校验之前按这一理由拒绝。
  if (name === 'consume_virtual_card') rejectClientSuppliedTime(args, { callId });
  validateSchemaParameters(name, args, callId, parameters[name as keyof typeof parameters]);
  if (args.amount !== undefined) {
    if (typeof args.amount !== 'string') throw new AppError('VALIDATION', 'Monetary amounts must be exact decimal strings.');
    const minor = moneyToCents(args.amount);
    if (minor < 0n || minor === 0n && name !== 'set_card_limit') throw new AppError('VALIDATION', 'The monetary amount is outside the capability domain.');
  }
  if (name === 'create_scheduled_task') {
    scheduledTime(args);
    validateScheduledPayload(args.kind as string, args.payload as Record<string, unknown> | undefined);
  }
}

/** Validate original arguments before Pi applies its permissive type coercion. */
export function validateSchemaParameters(name: string, args: Record<string, unknown>, callId: string,
  schema: Parameters<typeof validateToolArguments>[0]['parameters']): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AppError('VALIDATION', 'Tool arguments must be an object.');
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const unexpected = Object.keys(args).filter(key => !Object.hasOwn(properties, key));
  if (unexpected.length) {
    throw new AppError('VALIDATION', `Unsupported parameters: ${unexpected.join(', ')}.`, { callId });
  }
  const missing = ((schema as { required?: string[] }).required ?? []).filter(key => !Object.hasOwn(args, key));
  if (missing.length) throw new AppError('VALIDATION', `Missing required parameters: ${missing.join(', ')}.`, { callId });
  try {
    const before = JSON.stringify(args);
    const checked: unknown = validateToolArguments({ name, description: catalogEntry(name)?.description ?? name, parameters: schema },
      { type: 'toolCall', id: callId, name, arguments: structuredClone(args) as JsonObject });
    if (JSON.stringify(checked) !== before) throw new AppError('VALIDATION', 'Tool parameter types must be explicit; coercion is not accepted.');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('VALIDATION', 'The call contains invalid tool parameters.', { callId, cause: error });
  }
}
