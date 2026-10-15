import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { classifyActionFollowUp } from './action-follow-up';
import { classifyCardAction, classifyCardFreezePlan } from './card-intents';
import { classifyInvestmentAction } from './investment-intents';
import { classifySubscriptionAction } from './subscription-intents';
import { handleBudget, handlePlan, handleExplicitSequence, isConditionalPlan } from './plan-intents';
import { handleTransfer, isTransferIntent } from './transfer-intents';
import { plain, toolCall } from './replies';
import { inferConversationGuidance } from './conversation-guidance';
import { renderConversationGuidance } from '../../guidance-messages';
import { renderInvalidAmountResponse } from './invalid-amount-response';
import { isConversationRecallRequest, isConversationalRequest } from './conversation-policy';
import { contentToText, findLastUserIndex } from './conversation';
import { requestedMoneyAmounts } from './request-amounts';
import { subscriptionDiscussion } from './discussion';
import messagesText from './messages.zh-CN.json';
import { compactedRecallQuery } from './history';

const helpText = messagesText.help;

/** Dispatch specific actions before broad read intents; this classifier never authorizes writes. */
export function classify(text: string, messages: Message[]): AssistantMessage {
  const trimmed = text.trim();
  const guidance = inferConversationGuidance(trimmed);
  if (guidance) return plain(guidance === 'invalid_amount'
    ? renderInvalidAmountResponse(trimmed) : renderConversationGuidance(guidance));
  if (isConversationalRequest(trimmed)) {
    const discussion = subscriptionDiscussion(trimmed, messages);
    if (discussion) return plain(discussion);
    if (isConversationRecallRequest(trimmed)) {
      const earlier = messages.slice(0, findLastUserIndex(messages)).filter(message => message.role === 'user')
        .map(message => contentToText(message.content));
      const archived = compactedRecallQuery(trimmed, earlier);
      if (archived) return archived.query ? toolCall('search_conversation_history', { query: archived.query, limit: 5 })
        : plain(messagesText.historyKeywordRequired);
      const asksAmount = /(?:\u91d1\u989d|\u591a\u5c11)|\b(?:amount|how much)\b/i.test(trimmed);
      const previous = asksAmount ? earlier.findLast(text => requestedMoneyAmounts(text).length > 0 && !isConversationalRequest(text)) : earlier.at(-1);
      return plain(previous ? `${messagesText.recallPrefix}${JSON.stringify(previous)}` : messagesText.noEarlierMessage);
    }
    if (/(?:\u4ed8\u6b3e\u8d26\u6237|\u94b1\u5305|\u4ece\u54ea|\u8d44\u91d1\u8d26\u6237)|\b(?:funding|source|wallet|choose.*account)\b/i.test(trimmed)) {
      return plain(messagesText.fundingAccount);
    }
    if (/(?:\u5b9a\u65f6|\u8ba1\u5212\u4efb\u52a1)|\bscheduled?\s+tasks?\b/i.test(trimmed)) return plain(messagesText.scheduledTasks);
    if (/^(?:\u4f60\u597d|\u60a8\u597d|\u54c8\u55bd|\u55e8|hi|hello)/i.test(trimmed)
      || /(?:\u80fd\u505a\u4ec0\u4e48|\u6709\u54ea\u4e9b\u529f\u80fd|\u4ecb\u7ecd.*\u80fd\u529b)/.test(trimmed)) return plain(helpText);
    return plain(messagesText.conversation);
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
  if (/^help me make a transfer[.!?]?$/i.test(trimmed)) {
    return plain(JSON.stringify({ guidance: { code: 'missing_details', fields: ['recipient', 'amount'] } }));
  }
  const cardPlan = classifyCardFreezePlan(trimmed, messages);
  if (cardPlan) return cardPlan;
  if (isConditionalPlan(trimmed)) return handlePlan(trimmed);
  const sequence = handleExplicitSequence(trimmed, messages);
  if (sequence) return sequence;
  if (isTransferIntent(trimmed)) return handleTransfer(trimmed, messages);
  if (/(定时任务|计划任务|提醒任务|任务列表|自动任务)/.test(trimmed)) return toolCall('list_scheduled_tasks', {});
  const action = classifyCardAction(trimmed) ?? classifyInvestmentAction(trimmed) ??
    classifySubscriptionAction(trimmed) ?? classifyActionFollowUp(trimmed, messages);
  if (action) return action;
  if (/(异常|可疑|奇怪|盗刷|被刷|乱扣|乱花|不对的消费)/.test(trimmed)) return toolCall('detect_anomaly', {});
  if (/(流水|明细|记录|账单|交易)/.test(trimmed)) return toolCall('get_transactions', {});
  if (/(花了|花销|开销|消费|支出|花费|花掉)/.test(trimmed) || /\bspending\b/i.test(trimmed)) return toolCall('analyze_spending', {});
  if (/(概览|总资产|资产总览|总览|资产情况|家底)/.test(trimmed)) return toolCall('get_dashboard_summary', {});
  if (/(余额|还剩|存款|活期|有多少钱|多少钱)/.test(trimmed) || /\bbalances?\b/i.test(trimmed)) return toolCall('get_balance', {});
  if (/(卡片|银行卡|信用卡|哪张卡|额度|卡号)/.test(trimmed)) return toolCall('get_cards', {});
  if (/(订阅|会员|自动续费|续费)/.test(trimmed) || /\bsubscriptions?\b/i.test(trimmed)) return toolCall('list_subscriptions', {});
  if (/(持仓|持有|我买的)/.test(trimmed)) return toolCall('get_investment_holdings', {});
  if (/(理财|投资|基金|产品)/.test(trimmed)) return toolCall('list_investments', {});
  if (/(预留|预算|攒钱|存钱|专款|存一笔)/.test(trimmed)) return handleBudget(trimmed);
  if (/(联系人|通讯录)/.test(trimmed)) {
    const query = trimmed.match(/(?:联系人|通讯录)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z·]{1,20})/)?.[1]?.trim() ?? '';
    return toolCall('search_contact', { query });
  }
  return plain(helpText);
}
