const FINANCIAL_SUBJECT = /(?:\u8ba2\u9605|\u4f1a\u5458|\u6d88\u8d39|\u82b1\u94b1|\u652f\u51fa|\u9884\u7b97|\u7406\u8d22|\u57fa\u91d1|\u6295\u8d44|\u5361\u7247|\u8d26\u6237)|\b(?:subscriptions?|memberships?|spending|expenses?|budget|investments?|funds?|cards?|accounts?)\b/i;
const ADVICE_QUESTION = /(?:\u54ea[\u4e2a\u4e9b\u9879\u79cd].{0,20}(?:\u53ef\u4ee5|\u5e94\u8be5|\u9002\u5408|\u503c\u5f97|\u4e0d\u9700\u8981|\u53d6\u6d88|\u9000\u6389)|\u662f\u5426\u503c\u5f97|\u8981\u4e0d\u8981|\u8be5\u4e0d\u8be5|\u600e\u4e48.{0,12}\u7701\u94b1|\u8282\u7701|\u5efa\u8bae|\u63a8\u8350|\u8bc4\u4f30|\u4f18\u5316\u652f\u51fa)|\b(?:advice|recommend|recommendation|evaluate|assess|worth|which.+(?:should|could|can)|should I|save money|reduce (?:my )?spending)\b/i;
const EXECUTION_START = /^(?:\u73b0\u5728|\u76f4\u63a5|\u8bf7|\u5e2e\u6211|\u7ed9\u6211)?\s*(?:\u53d6\u6d88|\u9000\u6389|\u9000\u8ba2|\u8d2d\u4e70|\u4e70\u5165|\u7533\u8d2d|\u8d4e\u56de|\u51bb\u7ed3|\u89e3\u51bb|\u6302\u5931|\u8f6c\u7ed9|\u8f6c\u8d26|\u8bbe\u7f6e|\u521b\u5efa)|^(?:(?:please|now|go ahead and|help me)\s+)?(?:cancel|unsubscribe|purchase|buy|redeem|freeze|unfreeze|send|transfer|set|create)\b/i;

/** Offline script interpretation only; production intent is declared through a structured tool. */
export function classifyAdvisoryRequest(request: string): 'advice' | 'mixed' | undefined {
  const text = request.trim();
  if (!FINANCIAL_SUBJECT.test(text) || !ADVICE_QUESTION.test(text)) return;
  const clauses = text.split(/[\n,;\u3002\uff0c\uff1b]+|(?:\u7136\u540e|\u518d|\u987a\u4fbf|\u5e76\u4e14|\u5e76)(?=\s*(?:\u5e2e\u6211|\u8bf7|\u76f4\u63a5|\u53d6\u6d88|\u8d2d\u4e70|\u7533\u8d2d|\u8d4e\u56de|\u51bb\u7ed3|\u8f6c|\u8bbe\u7f6e|\u521b\u5efa))|\b(?:and then|then|also|and)\s+(?=(?:please\s+)?(?:cancel|buy|purchase|redeem|freeze|send|transfer|set|create)\b)/i);
  const explicit = clauses.some(clause => EXECUTION_START.test(clause.trim()) &&
    !/(?:\u662f\u5426\u503c\u5f97|\u503c\u4e0d\u503c\u5f97)[?\uff1f\s]*$/.test(clause.trim()));
  return explicit ? 'mixed' : 'advice';
}

export function isAdvisoryRequest(request: string): boolean {
  return classifyAdvisoryRequest(request) === 'advice';
}
