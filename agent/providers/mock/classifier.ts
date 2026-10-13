import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { classifyActionFollowUp } from './action-follow-up';
import { classifyCardAction } from './card-intents';
import { classifyInvestmentAction } from './investment-intents';
import { classifySubscriptionAction } from './subscription-intents';
import { handleBudget, handlePlan, isConditionalPlan } from './plan-intents';
import { handleTransfer, isTransferIntent } from './transfer-intents';
import { plain, toolCall } from './replies';

const helpText =
  '你好，我是你的银行智能助手。你可以让我查询余额、交易明细、消费分析、卡片、订阅、理财和定时任务，' +
  '也可以发起转账等操作（其中中等及高风险操作需要你确认或通过验证码验证后才会执行）。请问需要我做什么？';

/** Dispatch specific actions before broad read intents; this classifier never authorizes writes. */
export function classify(text: string, messages: Message[]): AssistantMessage {
  const trimmed = text.trim();
  if (/赎回/.test(trimmed) && /(部分|只赎回\s*\d|只想.*赎回\s*\d|剩下.*持有|不要全额赎回)/.test(trimmed)) {
    return plain(JSON.stringify({ guidance: { code: 'partial_redemption_unsupported' } }));
  }
  if (/(申购|认购|买)/.test(trimmed) && /储蓄账户/.test(trimmed)) {
    return plain(JSON.stringify({ guidance: { code: 'investment_funding_account_unsupported' } }));
  }
  if (/(总授信额度|总额度)/.test(trimmed) && /(调整|提高|修改)/.test(trimmed)) {
    return plain(JSON.stringify({ guidance: { code: 'credit_line_adjustment_unsupported' } }));
  }
  if (/(能做什么|有哪些功能|介绍.*能力)/.test(trimmed)) {
    return plain(JSON.stringify({ guidance: { code: 'capabilities' } }));
  }
  if (trimmed === '' || /^(你好|您好|hi|hello|哈喽|嗨|在吗)[!！。？?~～\s]*$/i.test(trimmed)) return plain(helpText);
  if (isTransferIntent(trimmed)) return handleTransfer(trimmed, messages);
  if (/(定时任务|计划任务|提醒任务|任务列表|自动任务)/.test(trimmed)) return toolCall('list_scheduled_tasks', {});
  if (isConditionalPlan(trimmed)) return handlePlan(trimmed);
  const action = classifyCardAction(trimmed) ?? classifyInvestmentAction(trimmed) ??
    classifySubscriptionAction(trimmed) ?? classifyActionFollowUp(trimmed, messages);
  if (action) return action;
  if (/(异常|可疑|奇怪|盗刷|被刷|乱扣|乱花|不对的消费)/.test(trimmed)) return toolCall('detect_anomaly', {});
  if (/(流水|明细|记录|账单|交易)/.test(trimmed)) return toolCall('get_transactions', {});
  if (/(花了|花销|开销|消费|支出|花费|花掉)/.test(trimmed)) return toolCall('analyze_spending', {});
  if (/(概览|总资产|资产总览|总览|资产情况|家底)/.test(trimmed)) return toolCall('get_dashboard_summary', {});
  if (/(余额|还剩|存款|活期|有多少钱|多少钱)/.test(trimmed)) return toolCall('get_balance', {});
  if (/(卡片|银行卡|信用卡|哪张卡|额度|卡号)/.test(trimmed)) return toolCall('get_cards', {});
  if (/(订阅|会员|自动续费|续费)/.test(trimmed)) return toolCall('list_subscriptions', {});
  if (/(持仓|持有|我买的)/.test(trimmed)) return toolCall('get_investment_holdings', {});
  if (/(理财|投资|基金|产品)/.test(trimmed)) return toolCall('list_investments', {});
  if (/(预留|预算|攒钱|存钱|专款|存一笔)/.test(trimmed)) return handleBudget(trimmed);
  if (/(联系人|通讯录)/.test(trimmed)) {
    const query = trimmed.match(/(?:联系人|通讯录)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z·]{1,20})/)?.[1]?.trim() ?? '';
    return toolCall('search_contact', { query });
  }
  return plain(helpText);
}
