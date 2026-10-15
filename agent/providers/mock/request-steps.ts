import { REQUEST_COMMANDS } from './request-command-patterns';

export type RequestedStep = { tool: string; span: string };
const VERB = '(?:从|用|预留|查询|查看|查|看|分析|转|给|设置|调整|将|把|创建|安排|取消|申购|认购|赎回|冻结|解冻|挂失|补办|补卡|比较|对比|申请|修改)';
const NEGATION = '(?:不要|不必|不用|无需|不需要|不要求)';
const SEPARATOR = new RegExp(`(?:[，,。；;\\n]+|(?:随后|然后|接着|再|最后|并且|以及|同时|和|但是|但|不过|而)(?=\\s*(?:${NEGATION}\\s*)?${VERB}))`, 'g');

/** Bounded explicit Chinese commands only; prose is never proof of authorization/completeness. */
export function requestedSteps(request: string): RequestedStep[] {
  const explicit = request.replace(/(?:只有|仅当)[^，,。；;\n]*?成功(?:之后|以后|后)?\s*[，,]?\s*(?:才|再)\s*/g, '')
    // A timing/bypass demand attached to a transfer is not a second payment instruction.
    // This removes no permissions: the original transfer remains subject to confirmation/MFA.
    .replace(/[，,]\s*(?:请)?(?:直接|立即|马上|立刻)转账\s*(?=$|[，,。；;])/g, '');
  return explicit.split(SEPARATOR).flatMap(rawSpan => {
    // A source outcome in "转账失败时不要创建提醒" references an existing operation.
    const span = rawSpan.replace(/^\s*(?:(?:这|该)笔|这次|如果|若)?(?:转账|申购|认购|赎回|操作)(?:成功|失败)(?:之后|以后|后|时)\s*(?:就|才|再)?\s*/, '');
    const commands = Object.entries(REQUEST_COMMANDS).flatMap(([tool, pattern]) => {
      const match = pattern.exec(span);
      // "给张伟不要转100元" negates the verb, not the recipient prefix in the regex.
      const verbOffset = tool === 'transfer_money' && match ? match[0].lastIndexOf('转') : 0;
      return match ? [{ tool, index: match.index + Math.max(verbOffset, 0) }] : [];
    }).sort((a, b) => a.index - b.index);
    // A reminder called “转账成功提醒” does not create a second transfer request.
    const first = commands[0];
    if (!first) return [];
    const negation = new RegExp(NEGATION).exec(span);
    if (negation && negation.index < first.index) return []; // Negated business operation.
    // Later negation is a qualifier on an already requested operation (e.g. no remark/repeat).
    // Keep that operation, but do not bind its amount/person to text in the negative qualifier.
    return [{ tool: first.tool, span: negation ? span.slice(0, negation.index) : span }];
  });
}

