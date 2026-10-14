/** Public output contracts used to validate workflow data references. */
export interface OutputFieldContract {
  type: 'decimal' | 'number' | 'string' | 'boolean' | 'object' | 'array';
  fields?: Readonly<Record<string, OutputFieldContract>>;
  items?: OutputFieldContract;
  additionalProperties?: OutputFieldContract;
}

export type ToolOutputContracts = Readonly<Record<string, OutputFieldContract>>;

const decimal: OutputFieldContract = { type: 'decimal' };
const number: OutputFieldContract = { type: 'number' };
const string: OutputFieldContract = { type: 'string' };
const boolean: OutputFieldContract = { type: 'boolean' };
const object = (fields: Readonly<Record<string, OutputFieldContract>>): OutputFieldContract => ({ type: 'object', fields });
const array = (items: OutputFieldContract): OutputFieldContract => ({ type: 'array', items });
const transaction = object({ id: string, accountId: string, amount: decimal, currency: string,
  direction: string, category: string, merchant: string, channel: string, remark: string,
  counterpartyId: string, occurredAt: number, isAnomaly: boolean, anomalyReason: string });
const account = object({ id: string, type: string, name: string, numberMasked: string, balance: decimal, currency: string });
const card = object({ id: string, type: string, network: string, numberMasked: string, status: string,
  creditLimit: decimal, availableLimit: decimal, monthlyLimit: decimal,
  limits: array(object({ category: string, amount: decimal })) });
const contact = object({ id: string, name: string, phone: string, bank: string, remark: string });
const subscription = object({ id: string, name: string, amount: decimal, cycle: string,
  nextChargeAt: number, status: string, remind: boolean });
const product = object({ id: string, code: string, name: string, riskLevel: string, annualYieldRate: decimal,
  termDays: number, minAmount: decimal, description: string });
const investmentResult = object({ success: boolean, holdingId: string, productId: string, amount: decimal,
  newBalance: decimal, sourceAccountId: string, occurredAt: number,
  redemptionValuation: decimal, settlementRounding: string });
const scheduledTask = object({ id: string, name: string, kind: string, runAt: number, status: string,
  requiresConfirmation: boolean, createdAt: number });

export const BANKING_TOOL_OUTPUTS: ToolOutputContracts = {
  get_balance: object({ totalAvailable: decimal, currency: string, accounts: array(account), asOf: number }),
  get_transactions: array(transaction),
  search_contact: array(contact),
  analyze_spending: object({ month: string, total: decimal, bookedTotal: decimal, flaggedTotal: decimal, prevTotal: decimal, momChangePct: decimal,
    byCategory: array(object({ category: string, amount: decimal, share: decimal })),
    categoryTotals: { type: 'object', additionalProperties: decimal },
    topMerchant: object({ merchant: string, amount: decimal, count: number }),
    monthlyTrend: array(object({ month: string, amount: decimal })), largest: transaction }),
  detect_anomaly: object({ scanned: number, generatedAt: number, cards: array(card),
    anomalies: array(object({ transaction, reason: string, severity: string, acknowledged: boolean })) }),
  get_cards: array(card),
  list_subscriptions: array(subscription),
  list_investments: array(product),
  compare_investments: object({ products: array(product), highestRateId: string, lowestRiskId: string }),
  get_investment_holdings: array(object({ id: string, productId: string, productName: string, riskLevel: string,
    amount: decimal, marketValue: decimal, profit: decimal, boughtAt: number, status: string, product })),
  get_dashboard_summary: object({ totalAssets: decimal, checkingBalance: decimal, creditAvailable: decimal,
    monthSpend: decimal, month: string, recentTransactions: array(transaction),
    latestAnomaly: object({ transaction, reason: string, severity: string }), asOf: number }),
  list_scheduled_tasks: array(scheduledTask),
  reserve_budget: object({ id: string, name: string, amount: decimal, purpose: string, status: string,
    dueDate: number, createdAt: number }),
  transfer_money: object({ success: boolean, transactionId: string, sourceAccountId: string, newBalance: decimal,
    recipient: object({ contactId: string, name: string, phone: string, bank: string }), amount: decimal,
    remark: string, occurredAt: number }),
  set_card_limit: card,
  cancel_subscription: subscription,
  freeze_card: card,
  apply_virtual_card: card,
  set_subscription_reminder: subscription,
  create_scheduled_task: scheduledTask,
  subscribe_investment: investmentResult,
  redeem_investment: investmentResult,
  report_lost_card: card,
  unfreeze_card: card,
};

export function outputFieldAt(contract: OutputFieldContract, path: readonly string[]): OutputFieldContract | undefined {
  let current: OutputFieldContract | undefined = contract;
  for (const segment of path) {
    if (current?.type === 'array') {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current.items;
    } else if (current?.type === 'object') {
      current = current.fields?.[segment] ?? current.additionalProperties;
    } else return undefined;
  }
  return current;
}
