import type { TaskNodeSpec } from './contracts/task';
import { AppError } from './errors';
import { moneyToCents } from './money';
import { REQUEST_COMMANDS } from './request-constraints';

export type RequestedStep = { tool: string; span: string };
const WRITE_TOOLS = new Set(['reserve_budget', 'transfer_money', 'set_card_limit', 'freeze_card',
  'unfreeze_card', 'report_lost_card', 'cancel_subscription', 'set_subscription_reminder',
  'create_scheduled_task', 'subscribe_investment', 'redeem_investment', 'apply_virtual_card', 'change_password']);
const VERB = '(?:从|用|预留|查询|查看|查|看|分析|转|给|设置|调整|将|把|创建|安排|取消|申购|认购|赎回|冻结|解冻|挂失|比较|对比|申请|修改)';
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

export function requiresCompletePlan(request: string): boolean {
  const steps = requestedSteps(request);
  return steps.length > 1 && steps.some(step => WRITE_TOOLS.has(step.tool));
}

export const COMPLETE_PLAN_NOTICE = '本次包含多个业务步骤，必须先提交覆盖全部步骤的 submit_plan，再生成确认入口；不能先单独办理其中一步。请补齐计划，对象或步骤不明确时先澄清。';

const identityFields: Readonly<Record<string, string[]>> = {
  transfer_money: ['contactId', 'name', 'phone'],
  subscribe_investment: ['productId'], redeem_investment: ['holdingId'],
  set_card_limit: ['cardId'], freeze_card: ['cardId'], unfreeze_card: ['cardId'], report_lost_card: ['cardId'],
  cancel_subscription: ['subscriptionId'], set_subscription_reminder: ['subscriptionId'],
};

export function matchesRequestedStep(node: TaskNodeSpec, step: RequestedStep, names: ReadonlyMap<string, string[]>): boolean {
  if (node.kind !== 'tool' || node.tool !== step.tool) return false;
  let amountSpan = step.span.toLowerCase();
  for (const aliases of names.values()) for (const alias of aliases) {
    if (/[^\d.*\s]/.test(alias)) amountSpan = amountSpan.replaceAll(alias.toLowerCase(), '');
  }
  if (node.args?.amount !== undefined) {
    if (typeof node.args.amount !== 'string') return false;
    try {
      const expected = moneyToCents(node.args.amount);
      const amounts = [...amountSpan.matchAll(/(\d+(?:\.\d+)?)(万)?/g)].flatMap(m => {
        try { return [moneyToCents(m[1]) * (m[2] ? 10000n : 1n)]; } catch { return []; }
      });
      if (!amounts.includes(expected)) return false;
    } catch { return false; }
  }
  const selectors = (identityFields[node.tool!] ?? []).flatMap(field => {
    const value = node.args?.[field];
    return typeof value === 'string' ? names.get(value) ?? [value] : [];
  });
  if (selectors.length && !selectors.some(alias => step.span.toLowerCase().includes(alias.toLowerCase()))) return false;
  return true;
}

/** One-to-one coverage uses real tools/arguments, never node labels. Runs before any task/write. */
export function assertCompleteRequestedPlan(nodes: readonly TaskNodeSpec[], request: string,
  names: ReadonlyMap<string, string[]> = new Map()): void {
  if (!requiresCompletePlan(request)) return;
  const steps = requestedSteps(request);
  const available = new Set(nodes.filter(node => node.kind === 'tool'));
  for (const step of steps) {
    const candidate = [...available].find(node => matchesRequestedStep(node, step, names));
    if (!candidate) throw new AppError('VALIDATION', '计划遗漏步骤或对象/金额与请求不一致，尚未生成办理入口。' + COMPLETE_PLAN_NOTICE);
    available.delete(candidate);
  }
  if ([...available].some(node => WRITE_TOOLS.has(node.tool ?? ''))) {
    throw new AppError('VALIDATION', '计划包含额外或重复的写操作，尚未生成办理入口。' + COMPLETE_PLAN_NOTICE);
  }
}
