import { expect, it, vi } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, normalizeContext } from '@earendil-works/pi-ai';
import { withRequiredDeclaration } from './required-declaration';

const model = { ...fauxProvider().getModel(), provider: 'deepseek', api: 'openai-completions' as const };
const payload = { thinking: { type: 'disabled' }, tools: [{ type: 'function', function: { name: 'describe_turn' } }], messages: [] };
const context = normalizeContext({ messages: [] });

function fixture() {
  let output: unknown;
  let input: unknown = payload;
  const stream: StreamFn = async (currentModel, _context, options) => {
    output = await options?.onPayload?.(input, currentModel) ?? input;
    const events = createAssistantMessageEventStream();
    events.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('done') }); events.end();
    return events;
  };
  return { stream, output: () => output, input: (next: unknown) => { input = next; } };
}

it('requires only describe_turn during the corrective declaration and preserves payload hooks', async () => {
  const f = fixture(); const hook = vi.fn(() => ({ ...payload, marker: 'preserved' }));
  await (await withRequiredDeclaration(f.stream, () => true)(model, context, { onPayload: hook })).result();
  expect(f.output()).toMatchObject({ marker: 'preserved', tool_choice: { type: 'function', function: { name: 'describe_turn' } } });
  expect(hook).toHaveBeenCalledOnce();
  expect(payload).not.toHaveProperty('tool_choice');
});

it.each(['ordinary', 'thinking', 'other-provider', 'no-declaration-tool'])('preserves unsupported or unrelated requests (%s)', async mode => {
  const f = fixture();
  if (mode === 'thinking') f.input({ ...payload, thinking: { type: 'enabled' } });
  if (mode === 'no-declaration-tool') f.input({ ...payload, tools: [] });
  await (await withRequiredDeclaration(f.stream, () => mode !== 'ordinary')(
    mode === 'other-provider' ? { ...model, provider: 'other' } : model, context)).result();
  expect(f.output()).not.toHaveProperty('tool_choice');
});
