import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { handlePlan } from './plan-intents';
import { localizeToolLabel } from '@/lib/i18n/display';
import { createTranslator } from '@/lib/i18n/shared';

const zh = createTranslator('zh-CN');

interface PlanNode {
  id: string;
  name: string;
  tool?: string;
}

/** The mock's only submit_plan proposal: its analyze node must carry a Chinese display label. */
function analyzeNode(message: AssistantMessage): PlanNode {
  const plan = message.content.find(part => part.type === 'toolCall' && part.name === 'submit_plan');
  if (!plan || plan.type !== 'toolCall') throw new Error('Expected a submit_plan tool call');
  const nodes = (plan.arguments as { nodes?: PlanNode[] }).nodes ?? [];
  const node = nodes.find(candidate => candidate.tool === 'analyze_spending');
  if (!node) throw new Error('Expected an analyze_spending node');
  return node;
}

describe('mock plan node labels', () => {
  it('localizes the analyze node in the limit-adjustment branch', () => {
    const node = analyzeNode(handlePlan('如果我这个月消费超过2000，就把信用卡娱乐限额调整到1500元'));
    expect(localizeToolLabel(node.name, zh)).toBe('查询消费情况');
  });

  it('localizes the analyze node in the plain conditional-spend branch', () => {
    const message = handlePlan('如果这个月消费超过2000就提醒我');
    const plan = message.content.find(part => part.type === 'toolCall' && part.name === 'submit_plan');
    if (!plan || plan.type !== 'toolCall') throw new Error('Expected a submit_plan tool call');
    const nodes = (plan.arguments as { nodes?: PlanNode[] }).nodes ?? [];
    // This input must not reach the limit-adjustment branch.
    expect(nodes.some(candidate => candidate.tool === 'set_card_limit')).toBe(false);
    const node = analyzeNode(message);
    expect(localizeToolLabel(node.name, zh)).toBe('查询消费情况');
  });
});
