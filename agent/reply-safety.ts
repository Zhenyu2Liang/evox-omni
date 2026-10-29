import type { TurnBuffer } from './turns/contracts';
import { buildFinancialFacts } from './grounding-facts';
import { renderFinancialResponse } from './financial-response';

export const NO_SUBMITTED_OPERATION = '本轮尚未创建待确认操作，也未执行任何新的银行操作。';
export const UNKNOWN_BALANCE = '尚未取得本轮账户余额，请重新查询。';

/** Current-action assertions are presentation, never proof of a pending action or a receipt. */
function operationClauses(prose: string): string[] {
  return prose.split(/(?<=[。！？!?；;])|(?=\n)|(?<=\n)/u);
}

function isOperationClaim(source: string): boolean {
    const clause = source.replace(/[*_`]/g, '').replace(/^\s*(?:[-+]|\d+[.)])\s+/u, '');
    // Explicit quotation and examples remain available for history/explanation questions.
    if (/^\s*(?:>|[“"「]|例如|示例|假设|如果|若|当|历史|原话|你(?:之前|刚才)说|用户(?:之前)?说|if\b|when\b|an? example\b|for example\b|you (?:said|asked)\b)/iu.test(clause)) return false;
    if (/[?？]\s*$/.test(clause)) return false;
    if (/\b(?:has not|have not|was not|not yet|never|hasn't|haven't)\b/iu.test(clause) && !/\b(?:but|however)\b/iu.test(clause)) return false;
    const operation = /转账|汇款|付款|扣款|到账|冻结|挂失|补办|开卡|申购|赎回|订阅|限额|操作|任务|提交|transfer|payment|transaction|card|subscription|redemption|investment|schedule|request/iu;
    // “已实现收益 ... 未做过赎回” and “已到期，可以赎回” describe a position, not a completed
    // redemption. Check the intervening phrase rather than joining distant keyword matches.
    const completed = [...clause.matchAll(/(?:已(?:经)?|成功)([^。！？!?\n]{0,35}?)(提交|发起|办理|完成|转账|汇款|付款|支付|转出|转入|扣除|到账|冻结|挂失|补办|开通|取消|设置|调整|赎回|认购)/gu)]
      .some(match => !/(?:尚未|并未|未(?:做|曾|能|提交|完成|执行|办理|确认|验证|发生)|没有|并非|不能|不曾|拒绝|可以|能够|可能|将会|将于|需要|建议|考虑|如果|假如)/u.test(match[1]) &&
        !/(?:没有|尚未|并未|从未|不曾|未)\s*$/u.test(clause.slice(0, match.index)));
    return operation.test(clause) && (
      completed ||
      /(?:等待|等候|待你|请你|请在)[^。！？!?\n]{0,28}(?:确认|验证|验证码)/u.test(clause) ||
      /\b(?:has been|have been|was|were|is|I've|I have|I)\b[^.!?\n]{0,65}\b(?:submitted|initiated|completed|processed|sent|transferred|frozen|cancelled|canceled|redeemed)\b/iu.test(clause) ||
      /\b(?:transfer|payment|transaction|card|subscription|redemption|investment)\b[^.!?\n]{0,65}\b(?:submitted|initiated|completed|processed|sent|frozen|cancelled|canceled|redeemed|succeeded)\b/iu.test(clause) ||
      /^\s*(?:transferred|paid|redeemed|froze)\b/iu.test(clause) ||
      /\b(?:awaiting|waiting for|pending)\b[^.!?\n]{0,35}\b(?:confirmation|verification|approval)\b/iu.test(clause)
    );
}

export function hasOperationClaim(prose: string): boolean {
  return operationClauses(prose).some(isOperationClaim);
}

function isBalanceClaim(source: string): boolean {
  if (/^\s*(?:>|[“"「]|例如|示例|假设|如果|当|历史|原话|if\b|when\b|an? example\b|for example\b|you (?:said|asked)\b)/iu.test(source)) return false;
  const text = source.replace(/[*_`]/g, '');
  return /余额(?:\s|[|:：]|为|是|合计|总计|当前|约|显示|大约|总额){0,12}(?:[¥￥]\s*)?\d[\d,]*(?:\.\d+)?/u.test(text) ||
    /\bbalance\s+(?:is|are|was|equals)\s+(?:[¥￥$]\s*)?\d[\d,]*(?:\.\d+)?/iu.test(text);
}

export function hasBalanceClaim(prose: string): boolean {
  return operationClauses(prose).some(isBalanceClaim);
}

/** Keep independent explanation; only outcome assertions are replaced by server-owned facts. */
export function operationExplanation(prose: string): string {
  return operationClauses(prose).filter(clause => !isOperationClaim(clause) && !isBalanceClaim(clause)).join('').trim();
}

export function operationFactsReply(buffer: TurnBuffer): string {
  const pending = buffer.events.some(event => event.type === 'mfa_required') ? 'mfa'
    : buffer.events.some(event => event.type === 'confirmation_required') ? 'confirmation' : undefined;
  const writes = buildFinancialFacts(buffer.factResults).writes;
  if (buffer.balanceClaim && !buffer.operationClaim) {
    return writes.length || buildFinancialFacts(buffer.factResults).currentBalances.length ? renderFinancialResponse(buffer.factResults) : UNKNOWN_BALANCE;
  }
  const result = renderFinancialResponse(buffer.factResults, { pending });
  if (pending || writes.length) return result;
  return buffer.factResults.length ? `${result}\n${NO_SUBMITTED_OPERATION}` : NO_SUBMITTED_OPERATION;
}

/** Customer prose uses business labels; explicitly requested protocol examples stay verbatim. */
export function businessProse(prose: string, allowProtocolExamples = false): string {
  if (allowProtocolExamples) return prose;
  const labels: Record<string, string> = { REMINDER: '提醒', PAYMENT: '缴费', TRANSFER: '转账', CHECKING: '活期账户',
    sourceAccountId: '付款账户', create_scheduled_task: '创建定时任务', transfer_money: '转账' };
  return prose.replace(/\b(?:REMINDER|PAYMENT|TRANSFER|CHECKING|sourceAccountId|create_scheduled_task|transfer_money)\b/g,
    word => labels[word]);
}
