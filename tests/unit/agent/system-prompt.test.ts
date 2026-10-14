import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, HALLUCINATION_RULE } from '@/agent/system-prompt';
import { TOOL_CATALOG, AGENT_TOOL_NAMES as TOOL_NAMES } from '@/lib/contracts/tool-catalog';
import type { ToolName } from '@/lib/contracts/tools';

function toolLines(toolNames: readonly string[], prompt: string): string[] {
  return prompt.split('\n').filter(line => toolNames.some(name => line.startsWith(`- ${name}: `)));
}

function promptFor(toolNames: ToolName[]) {
  return buildSystemPrompt({ userId: 'demo-owner', toolNames });
}

describe('system prompt policy catalog alignment', () => {
  it('does not advertise disabled manual-only issuance even when an incorrect caller supplies it', () => {
    expect(toolLines(['apply_virtual_card'], promptFor(['apply_virtual_card']))).toEqual([]);
  });
  it('shows card freezing as RED and subscription reads as YELLOW', () => {
    const prompt = promptFor(['freeze_card', 'list_subscriptions']);
    expect(toolLines(['freeze_card'], prompt)).toEqual(['- freeze_card: RED']);
    expect(toolLines(['list_subscriptions'], prompt)).toEqual(['- list_subscriptions: YELLOW']);
  });

  it('derives every registered hint from effect, authorization mode and default tier', () => {
    const prompt = promptFor([...TOOL_NAMES]);
    for (const name of TOOL_NAMES) {
      const lines = toolLines([name], prompt);
      expect(lines, name).toHaveLength(1);
      const entry = TOOL_CATALOG[name];
      const tier = entry.effect === 'workflow' ? 'workflow' : entry.authorization !== 'static' ? 'dynamic' : entry.defaultTier;
      expect(lines[0], name).toBe(`- ${name}: ${tier}`);
    }
  });

  it('lists only the actual registered tools and retains the financial evidence rule', () => {
    const prompt = promptFor(['get_balance']);
    const lines = toolLines(TOOL_NAMES, prompt);
    expect(lines).toEqual(['- get_balance: GREEN']);
    expect(prompt).toContain(HALLUCINATION_RULE);
    expect(toolLines(TOOL_NAMES, promptFor([]))).toEqual([]);
  });

  it('retains unknown registered names defensively without borrowing inherited object properties', () => {
    const names = ['unknown_tool', 'constructor'];
    const prompt = promptFor(names as ToolName[]);
    const lines = toolLines(names, prompt);
    expect(lines).toEqual(['- unknown_tool: unknown', '- constructor: unknown']);
  });
});
