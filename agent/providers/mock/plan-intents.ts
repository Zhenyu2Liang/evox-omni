import type { AssistantMessage } from '@earendil-works/pi-ai';
import { parseAmount } from './amount-parser';
import { demoCreditCardId, parseCardLimitAdjustment } from './card-intents';
import { plain, toolCall } from './replies';

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
  const nodes: PlanNode[] = [];
  if (limitAdjustment !== undefined) {
    nodes.push({ id: 'analyze', name: '查询消费情况', dependencies: [], kind: 'tool', tool: 'analyze_spending', args: {} });
    nodes.push({
      id: 'check', name: '判断是否超过阈值', dependencies: ['analyze'], kind: 'condition',
      condition: { path: 'analyze.total', op: '>', value: threshold ?? '2000.00' },
    });
    nodes.push({
      id: 'setlimit', name: `调整「${limitAdjustment.category}」消费限额`, dependencies: ['check'], kind: 'tool',
      tool: 'set_card_limit', args: { cardId: demoCreditCardId, category: limitAdjustment.category, amount: limitAdjustment.amount },
    });
  } else if (/(消费|花|支出)/.test(text)) {
    nodes.push({ id: 'analyze', name: '查询消费情况', dependencies: [], kind: 'tool', tool: 'analyze_spending', args: {} });
    if (threshold != null) {
      nodes.push({
        id: 'check', name: '判断是否超过阈值', dependencies: ['analyze'], kind: 'condition',
        condition: { path: 'analyze.total', op: '>', value: threshold },
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
