import { describe, expect, it } from 'vitest';
import { normalizeContext, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { scriptedProvider, turnDeclaration } from '@/tests/helpers/scripted-provider';

describe('explicit scripted model declarations', () => {
  it('preserves ordered repeated operations and optional protocol/workflow metadata', () => {
    const message = turnDeclaration({ purpose: 'operation', operations: ['freeze_card', 'freeze_card'], workflow: true });
    expect(message.stopReason).toBe('toolUse');
    expect(message.content).toEqual([expect.objectContaining({ type: 'toolCall', name: 'describe_turn',
      arguments: { purpose: 'operation', operations: ['freeze_card', 'freeze_card'], workflow: true } })]);
    const example = turnDeclaration({ purpose: 'conversation', operations: [], allowProtocolExamples: true });
    expect(example.content).toEqual([expect.objectContaining({ arguments: {
      purpose: 'conversation', operations: [], allowProtocolExamples: true,
    } })]);
  });

  it('streams the declaration as the first actual provider request and then the scripted answer', async () => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage('Complete reply')]);
    const firstStream = await script.provider.streamFn(script.provider.model, normalizeContext({
      messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
    }));
    const first = await firstStream.result();
    expect(first.content).toEqual([expect.objectContaining({ type: 'toolCall', name: 'describe_turn' })]);
    expect(script.calls()).toBe(1);
    const secondStream = await script.provider.streamFn(script.provider.model, normalizeContext({ messages: [] }));
    const second = await secondStream.result();
    expect(second.content).toEqual([expect.objectContaining({ type: 'text', text: 'Complete reply' })]);
    expect(script.calls()).toBe(2);
  });
});
