import { isMoneyAmountReply, requestedMoneyAmounts } from './request-amounts';
import { isConversationalRequest } from './conversation-policy';
import { requestedSteps } from './request-steps';
import type { ConversationGuidanceCode } from '../../guidance-messages';

/** These decisions select presentation only; they never fill arguments or authorize a tool. */
export function inferConversationGuidance(request: string): ConversationGuidanceCode | undefined {
  const text = request.trim();
  if (/^(?:你好|您好|哈喽|嗨|在吗|hi|hello|hey)[!！。？?~～\s]*$/i.test(text)) return 'greeting';
  if (/^(?:谢谢|多谢|感谢|好的|好|谢谢你|thanks|thank you|ok|okay)[!！。,.，\s]*$/i.test(text)) return 'acknowledgement';
  if (/^(?:确认|我确认|确认一下|confirm|confirmed)[!！。,.，\s]*$/i.test(text)) return 'confirmation_in_chat';
  const negativeCorrection = /^(?:是\s*)?(?:[\-−－]\s*[¥￥$]?|[¥￥$]\s*[\-−－])\s*\d/.test(text) &&
    /(?:不是|搞错|说错|更正|纠正|弄错)/.test(text);
  if (!isConversationalRequest(text) || negativeCorrection) {
    const amountTools = new Set(['transfer_money', 'subscribe_investment', 'redeem_investment', 'reserve_budget', 'set_card_limit']);
    const instructions = requestedSteps(text).filter(step => amountTools.has(step.tool) && !isConversationalRequest(step.span));
    const invalid = instructions.some(step => requestedMoneyAmounts(step.span)
      .some(amount => amount.negative || amount.zero && step.tool !== 'set_card_limit'));
    const englishInstructions = text.split(/[，,。；;\n]/).filter(span =>
      !isConversationalRequest(span) && /\b(?:transfer|send|reserve|purchase|subscribe|redeem|(?:set|adjust|change).*limit)\b/i.test(span));
    const invalidEnglish = englishInstructions.some(span => requestedMoneyAmounts(span)
      .some(amount => amount.negative || amount.zero && !/\blimit\b/i.test(span)));
    const invalidReply = (isMoneyAmountReply(text) || negativeCorrection) &&
      requestedMoneyAmounts(text).some(amount => amount.negative || amount.zero);
    if (invalid || invalidEnglish || invalidReply) return 'invalid_amount';
  }
  const englishCardManagement = /\b(?:create|add|issue|remove|delete|close|cancel|apply\s+for)\s+(?:(?:a|an|the|my|new|another|virtual|credit|debit|bank|payment)\s+)*cards?\b/i;
  const chineseCardManagement = /(?:\u7533\u8bf7|\u6dfb\u52a0|\u65b0\u589e|\u5220\u9664|\u5220\u6389|\u6ce8\u9500|\u5f00\u901a|\u521b\u5efa|\u529e\u7406)(?:\u4e00\u5f20|\u4e24\u5f20|\u591a\u5f20|\d+\u5f20)?(?:\u65b0\u7684|\u6211\u7684|\u8fd9\u5f20|\u90a3\u5f20)?(?:\u94f6\u884c|\u4fe1\u7528|\u501f\u8bb0|\u50a8\u84c4|\u865a\u62df|\u5b9e\u4f53|\u65b0)*\u5361(?:\u7247)?/;
  if (englishCardManagement.test(text) || chineseCardManagement.test(text)) return 'card_management_required';
  if (/(?:不是|搞错|说错|更正|纠正|弄错)/.test(text) && !/(?:转账|转给|申购|赎回|冻结|解冻|挂失|设置|调整)/.test(text)) return 'correction_received';
  if (/(?:卡|card)/i.test(text) && /(?:增加|加上|加点|加\d|充值|充\d|top\s*up|add)/i.test(text) && !/(?:消费限额|分类限额|category limit)/i.test(text)) return 'card_operation_ambiguous';
  return undefined;
}
