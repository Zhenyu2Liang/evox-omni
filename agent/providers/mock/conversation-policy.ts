const BANKING_SUBJECT = /(?:\u8d26\u6237|\u4f59\u989d|\u6d41\u6c34|\u660e\u7ec6|\u8d26\u5355|\u4ea4\u6613|\u6d88\u8d39|\u652f\u51fa|\u5f02\u5e38|\u5361\u7247|\u94f6\u884c\u5361|\u4fe1\u7528\u5361|\u989d\u5ea6|\u8ba2\u9605|\u4f1a\u5458|\u7406\u8d22|\u57fa\u91d1|\u6301\u4ed3|\u8054\u7cfb\u4eba|\u5b9a\u65f6\u4efb\u52a1|\u8ba1\u5212\u4efb\u52a1|\u8d44\u4ea7|\u9884\u7b97)|\b(?:accounts?|balances?|transactions?|spending|cards?|subscriptions?|investments?|holdings?|contacts?|scheduled tasks?|budgets?)\b/i;
const READ_VERB = /(?:\u67e5\u8be2|\u67e5\u770b|\u770b\u770b|\u770b\u4e0b|\u770b(?=\u6709\u6ca1\u6709)|\u67e5\u4e00\u4e0b|\u5206\u6790|\u5217\u51fa|\u663e\u793a|\u5bf9\u6bd4|\u6bd4\u8f83)|\b(?:show|list|check|look up|analyze|compare|view)\b/i;
const WRITE_VERB = /(?:\u8f6c\u8d26|\u8f6c\u7ed9|\u8f6c(?=\s*\d)|\u7ed9.{1,30}\u8f6c|\u9884\u7559|\u51bb\u7ed3|\u89e3\u51bb|\u6302\u5931|\u7533\u8d2d|\u8ba4\u8d2d|\u8d4e\u56de|\u53d6\u6d88.*\u8ba2\u9605|\u4fee\u6539.*\u5bc6\u7801|\u8bbe\u7f6e.*\u9650\u989d|\u8c03\u6574.*\u9650\u989d|\u521b\u5efa.*\u63d0\u9192|\u8bbe\u7f6e.*\u63d0\u9192|\u63d0\u9192\u6211)|\b(?:transfer|send|reserve|freeze|unfreeze|redeem|subscribe|cancel a subscription|change my password)\b/i;
const TASK_VERB = /(?:\u521b\u5efa|\u5efa\u7acb|\u5b89\u6392|\u8bbe\u7f6e)|\b(?:create|schedule|set up)\b/i;
const EXPLANATION = /(?:\u600e\u4e48|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u51ed\u4ec0\u4e48|\u4ec0\u4e48\u610f\u601d|\u89e3\u91ca|\u8bf4\u660e.*\u89c4\u5219|\u5982\u4f55|\u6709\u4ec0\u4e48\u533a\u522b)|\b(?:how|why|explain|what does|what is the difference)\b/i;
const HYPOTHETICAL = /(?:\u5047\u5982|\u5047\u8bbe|\u4e3e\u4f8b|\u6bd4\u5982\u8bf4)|\b(?:suppose|hypothetically|for example|what if)\b/i;
const CAPABILITY = /^(?:\u4f60(?:\u53ef\u4ee5|\u80fd\u5426|\u80fd\u4e0d\u80fd|\u4f1a|\u80fd)|\u80fd(?:\u5426|\u4e0d\u80fd)?|\u662f\u5426\u652f\u6301|\u652f\u6301.*\u5417|\u6709\u54ea\u4e9b\u529f\u80fd)|^(?:can|could|do|will)\s+you\b|^do you support\b/i;
const REQUEST_HELP = /(?:\u5e2e\u6211|\u7ed9\u6211|\u8bf7)|\b(?:help me|please|for me)\b/i;
const OWNED_RESOURCE = /(?:\u6211\u7684|\u6211\u8d26\u6237|\u672c\u6708|\u8fd9\u4e2a\u6708|\u4eca\u5929|\u660e\u5929|\u6bcf\u6708|\u6bcf\u5929|\u5c3e\u53f7|\u7ed9.{1,20}\u8f6c|\u8f6c\u7ed9)|\b(?:my|today|tomorrow|every|this month|to [a-z]+)\b|\d+(?:\.\d+)?\s*(?:\u5143|CNY|yuan)|[\u00a5\uffe5$]\s*\d/i;
import { isMoneyAmountReply } from './request-amounts';
import { classifyAdvisoryRequest } from './advisory-policy';

const RECALL_QUESTION = /^(?:\u6211(?:\u521a\u624d|\u4e4b\u524d|\u4e0a\u6b21|\u524d\u9762)|(?:\u521a\u624d|\u4e4b\u524d|\u4e0a\u6b21|\u524d\u9762)(?:\u6211)?).*(?:\u8bf4(?:\u4e86)?\u4ec0\u4e48|\u95ee(?:\u4e86)?\u4ec0\u4e48|\u8981\u6c42.*\u591a\u5c11|\u8bf4.*\u591a\u5c11|\u63d0.*\u4ec0\u4e48)|^(?:what|which|who|how much)\b.*\b(?:did I|I just|I previously|I earlier|my last)\b/i;
const NEW_ACTION = /(?:\u6309|\u7528|\u7167|\u4ecd\u7136|\u7ee7\u7eed|\u518d|\u73b0\u5728|\u5e2e\u6211|\u8bf7).*(?:\u8f6c\u7ed9|\u8f6c\u8d26|\u7533\u8d2d|\u9884\u7559|\u8bbe\u7f6e|\u8c03\u6574)|\b(?:please|now|again|go ahead|using)\b.*\b(?:transfer|send|reserve|purchase|set)\b/i;

export function isConversationRecallRequest(text: string): boolean {
  return RECALL_QUESTION.test(text.trim()) && !NEW_ACTION.test(text);
}

function isConversationalClause(text: string): boolean {
  const bankingSubject = BANKING_SUBJECT.test(text) || /(?:\u82b1\u4e86|\u82b1\u9500|\u5f00\u9500|\u82b1\u8d39|\u6982\u89c8|\u603b\u8d44\u4ea7)/.test(text);
  if (isMoneyAmountReply(text)) return false;
  if (isConversationRecallRequest(text)) return true;
  if (bankingSubject && /^(?:how much|what are my)\b/i.test(text)) return false;
  if (EXPLANATION.test(text) || HYPOTHETICAL.test(text)) return true;
  if (CAPABILITY.test(text) && !REQUEST_HELP.test(text) && !OWNED_RESOURCE.test(text)) return true;
  if (READ_VERB.test(text) && bankingSubject) return false;
  if (bankingSubject && /\u67e5/.test(text)) return false;
  if (WRITE_VERB.test(text)) return false;
  if (bankingSubject && /(?:\u8d2d\u4e70|\u4e70\u5165|\u4e70|\u53d6\u51fa|\u53d6\u6d88|\u9000\u8ba2|\u5f00\u542f|\u5173\u95ed|\u8bbe\u7f6e|\u8c03\u6574)|\b(?:buy|purchase|withdraw|cancel|enable|disable|set|adjust)\b/i.test(text)) return false;
  if (TASK_VERB.test(text) && bankingSubject) return false;
  if (bankingSubject && (OWNED_RESOURCE.test(text) || /(?:\u591a\u5c11|\u8fd8\u5269|\u6709\u54ea\u4e9b|\u6709\u6ca1\u6709)|\b(?:how much|which|what are my)\b/i.test(text))) return false;
  if (/\u6211.*(?:\u6709|\u5269).*\u591a\u5c11\u94b1/.test(text)) return false;
  if (/^(?:\u4f59\u989d|\u6d41\u6c34|\u8d26\u5355|\u5361\u7247|\u8ba2\u9605|\u6301\u4ed3|\u6982\u89c8|\u603b\u8d44\u4ea7|\u5b9a\u65f6\u4efb\u52a1|balances?|transactions?|subscriptions?|holdings?)[?\u3002\uff1f\s]*$/i.test(text)) return false;
  return true;
}

/** Select conversational presentation only; financial authorization still belongs to the gateway. */
export function isConversationalRequest(request: string): boolean {
  const advice = classifyAdvisoryRequest(request);
  if (advice) return advice === 'advice';
  const clauses = request.trim().split(/[\n,;\u3002\uff0c\uff1b]+|(?:\u7136\u540e|\u63a5\u7740|\u968f\u540e|\u6700\u540e|\u518d)(?=\s*(?:\u8f6c|\u7ed9|\u67e5|\u521b\u5efa|\u8bbe\u7f6e|\u51bb\u7ed3))|\band then\b/i)
    .map(clause => clause.trim()).filter(Boolean);
  return clauses.every(isConversationalClause);
}
