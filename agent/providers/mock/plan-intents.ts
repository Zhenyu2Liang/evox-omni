import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { parseAmount } from './amount-parser';
import { demoCreditCardId, parseCardLimitAdjustment, classifyCardAction } from './card-intents';
import { classifyInvestmentAction } from './investment-intents';
import { classifySubscriptionAction } from './subscription-intents';
import { parseTransfer, priorTransferRecipient } from './transfer-intents';
import { requestedSteps } from './request-steps';
import { requestedMoneyAmounts } from './request-amounts';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import sequenceMessages from './sequence-messages.zh-CN.json';
import { plain, toolCall } from './replies';
import { requestedConditions } from './request-conditions';
import { demoNow } from '@/lib/clock';
import { businessCalendarParts, businessDate } from '@/lib/date';

interface PlanNode {
  id: string;
  name: string;
  dependencies: string[];
  kind: 'tool' | 'condition' | 'note';
  tool?: string;
  args?: Record<string, unknown>;
  condition?: { path: string; op: '>' | '>=' | '<' | '<=' | '==' | '!='; value: number | string | boolean };
}

export function isConditionalPlan(text: string): boolean {
  return /如果|就提醒|就通知|就告诉我|帮我规划|帮我计划|规划一下|计划一下|帮我安排|自动化|设定条件|超过[^。！？]*就/.test(text);
}

/** Compile deterministic requests into the same validated planner port as the live model. */
export function handlePlan(text: string): AssistantMessage {
  const threshold = text.match(/(?:超过|大于|高于|多于|超出|>=?|＞)\s*(\d+(?:\.\d+)?)/)?.[1];
  const limitAdjustment = parseCardLimitAdjustment(text);
  const requested = requestedConditions(text)[0];
  const current = businessCalendarParts(demoNow());
  const period = businessCalendarParts(businessDate(current.year, current.month - (requested?.period.relative === 'previous' ? 1 : 0)));
  const analysisArgs = { month: requested?.period.month ?? `${period.year}-${String(period.month + 1).padStart(2, '0')}` };
  const condition = { path: requested?.category ? `analyze.categoryTotals.${requested.category}` : 'analyze.total',
    op: requested?.operator ?? '>' as const, value: requested?.threshold ?? threshold ?? '2000.00' };
  const nodes: PlanNode[] = [];
  if (limitAdjustment !== undefined) {
    nodes.push({ id: 'analyze', name: '查询消费情况', dependencies: [], kind: 'tool', tool: 'analyze_spending', args: analysisArgs });
    nodes.push({
      id: 'check', name: '判断是否超过阈值', dependencies: ['analyze'], kind: 'condition',
      condition,
    });
    nodes.push({
      id: 'setlimit', name: `调整「${limitAdjustment.category}」消费限额`, dependencies: ['check'], kind: 'tool',
      tool: 'set_card_limit', args: { cardId: demoCreditCardId, category: limitAdjustment.category, amount: limitAdjustment.amount },
    });
  } else if (/(消费|花|支出)/.test(text)) {
    nodes.push({ id: 'analyze', name: '查询消费情况', dependencies: [], kind: 'tool', tool: 'analyze_spending', args: analysisArgs });
    if (threshold != null) {
      nodes.push({
        id: 'check', name: '判断是否超过阈值', dependencies: ['analyze'], kind: 'condition',
        condition,
      });
      nodes.push({ id: 'remind', name: '发送提醒', dependencies: ['check'], kind: 'note' });
    } else nodes.push({ id: 'summarize', name: '汇总结果', dependencies: ['analyze'], kind: 'note' });
  } else if (/余额/.test(text)) {
    nodes.push({ id: 'balance', name: '查询账户余额', dependencies: [], kind: 'tool', tool: 'get_balance', args: {} });
    nodes.push({ id: 'summarize', name: '汇总结果', dependencies: ['balance'], kind: 'note' });
  } else nodes.push({ id: 'note', name: '执行计划', dependencies: [], kind: 'note' });
  return toolCall('submit_plan', { goal: text, nodes });
}

export function handleBudget(text: string): AssistantMessage {
  const amount = parseAmount(text);
  if (amount == null) return plain('请问要预留多少钱？例如“帮我预留2000元买手机”。');
  const purpose = text.replace(/[\d零一二三四五六七八九十百千万两]+\s*(?:元|块钱|块|人民币)?/g, '')
    .replace(/(帮我|请|我想|我要|麻烦|给我|先|预留|留出|留|预算|攒钱|存钱|攒|存|一笔|专款|用于|用来|为了|块钱|的|元|块)/g, '')
    .replace(/[，,。.、！!？?~～\s]+/g, '').trim() || undefined;
  const args: Record<string, unknown> = { name: purpose ?? '预算预留', amount };
  if (purpose) args.purpose = purpose;
  return toolCall('reserve_budget', args);
}

/** Build a deterministic complete candidate; the shared preflight still validates every node. */
export function handleExplicitSequence(text: string, messages: Message[]): AssistantMessage | undefined {
  const steps = requestedSteps(text);
  if (steps.length < 2 || !steps.some(step => catalogEntry(step.tool)?.effect === 'write')) return;
  const nodes: PlanNode[] = [];
  for (const step of steps) {
    if (requestedMoneyAmounts(step.span).some(amount => amount.negative || amount.zero && step.tool !== 'set_card_limit')) {
      return plain(sequenceMessages.invalidAmount);
    }
    let proposal: AssistantMessage | undefined;
    if (step.tool === 'transfer_money') {
      const transfer = parseTransfer(step.span);
      const previous = transfer.explicitReuse ? priorTransferRecipient(messages) : undefined;
      const recipient = transfer.recipient ? { name: transfer.recipient } : previous;
      if (!recipient || !transfer.amount) return plain(sequenceMessages.missingDetails);
      proposal = toolCall('transfer_money', { ...recipient, amount: transfer.amount,
        ...(transfer.remark ? { remark: transfer.remark } : {}) });
    } else if (step.tool === 'reserve_budget') proposal = handleBudget(step.span);
    else if (step.tool === 'create_scheduled_task') {
      const date = /(20\d{2})[\u5e74/-](\d{1,2})[\u6708/-](\d{1,2})\u65e5?\s*(\d{1,2})[:\uff1a](\d{2})/.exec(step.span);
      if (!date) return plain(sequenceMessages.missingDetails);
      const runAtLocal = date[1] + '-' + date[2].padStart(2, '0') + '-' + date[3].padStart(2, '0') +
        'T' + date[4].padStart(2, '0') + ':' + date[5];
      proposal = toolCall('create_scheduled_task', { name: step.span, kind: 'REMINDER', runAtLocal });
    } else if (catalogEntry(step.tool)?.effect === 'read') {
      proposal = toolCall(step.tool, {});
    } else proposal = classifyCardAction(step.span) ?? classifyInvestmentAction(step.span) ?? classifySubscriptionAction(step.span);
    const call = proposal?.content.find(part => part.type === 'toolCall' && part.name === step.tool);
    if (!call || call.type !== 'toolCall') return proposal ?? plain(sequenceMessages.missingDetails);
    const id = 'step-' + (nodes.length + 1);
    nodes.push({ id, name: step.span, kind: 'tool', tool: call.name, args: call.arguments,
      dependencies: nodes.length ? [nodes[nodes.length - 1].id] : [] });
  }
  return toolCall('submit_plan', { goal: text, nodes });
}
