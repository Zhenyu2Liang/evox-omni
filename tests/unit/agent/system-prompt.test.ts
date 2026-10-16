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
  it('advertises agent-enabled virtual card issuance as a RED write', () => {
    expect(toolLines(['apply_virtual_card'], promptFor(['apply_virtual_card']))).toEqual(['- apply_virtual_card: RED']);
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

describe('system prompt forbids a fabricated confirmation/verification panel', () => {
  it('ties a real gate to a parked controlled-write tool result and forbids claiming one without it', () => {
    const prompt = promptFor(['transfer_money']);
    // A panel exists only because the gateway parked a real tool call into a pending state.
    expect(prompt).toContain('An approval or verification panel exists only after you actually called the controlled-write tool and the gateway parked it into that pending state');
    expect(prompt).toContain('ordinary prose never creates or displays one');
    expect(prompt).toContain('call the required tool now so the real gate is created');
    // Claiming an initiated or awaited gate without such a tool result is explicitly forbidden.
    expect(prompt).toContain('Do not claim to have initiated an operation, do not ask the user to confirm or approve "in the panel"');
    expect(prompt).toContain('do not say you are waiting for confirmation or verification unless a real tool result returned that waiting state');
    expect(HALLUCINATION_RULE).toContain('never claim that a confirmation or verification gate is pending, waiting or displayed unless a tool result actually returned that waiting state');
  });

  it('no longer presents the panel above the composer as an unconditional state', () => {
    const prompt = promptFor(['transfer_money']);
    // The old permissive sentence asserted the panel unconditionally — exactly what seeded the
    // hallucination. It must now appear only as the consequence of a real gate.
    expect(prompt).not.toContain('Do not claim completion or invent a receipt. The interface presents approval and verification in a separate request panel above the composer.');
    expect(prompt).toContain('When a real gate exists, the interface presents approval and verification in a separate request panel above the composer');
  });
});
