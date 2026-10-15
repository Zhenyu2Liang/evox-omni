import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';

/** Each proposed call gets a distinct provider identity; persisted calls retain it on replay. */
export function toolCall(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([
    fauxText(actionText[name] ?? '好的，我来处理一下。'),
    fauxToolCall(name, JSON.parse(JSON.stringify(args)) as JsonObject),
  ], { stopReason: 'toolUse' });
}

export function plain(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

const actionText: Record<string, string> = {
  get_balance: '好的，我来查一下你的账户余额。',
  get_transactions: '好的，我来查一下你的交易明细。',
  analyze_spending: '好的，我来分析一下你的消费情况。',
  detect_anomaly: '好的，我来检查一下最近的异常消费。',
  get_cards: '好的，我来查一下你的卡片信息。',
  list_subscriptions: '好的，我来查一下你的订阅情况。',
  list_investments: '好的，我来查一下理财产品。',
  compare_investments: '好的，我来为你对比这些理财产品。',
  get_investment_holdings: '好的，我来查一下你的理财持仓。',
  get_dashboard_summary: '好的，我来为你生成资产概览。',
  list_scheduled_tasks: '好的，我来查一下你的定时任务。',
  search_contact: '好的，我来查找这位联系人。',
  transfer_money: '好的，我来为你处理这笔转账。',
  set_card_limit: '好的，我来为你调整这张卡片的分类消费限额。',
  freeze_card: '好的，我来为你冻结这张卡片。',
  report_lost_card: '好的，我来为你挂失这张卡片。',
  replace_card: '好的，我来为你补办一张新卡。',
  apply_virtual_card: '好的，我来为你申请一张虚拟卡。',
  cancel_subscription: '好的，我来为你取消这个订阅。',
  subscribe_investment: '好的，我来为你办理理财申购。',
  redeem_investment: '好的，我来为你办理理财赎回。',
  reserve_budget: '好的，我来为你预留这笔预算。',
  submit_plan: '好的，我来为你规划一个任务计划。',
};
