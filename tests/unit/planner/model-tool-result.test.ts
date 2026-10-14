import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runToolCall } from '@earendil-works/pi-agent-core';
import { createToolRegistry } from '@/agent/tools';
import { AGENT_TOOL_NAMES } from '@/lib/contracts/tool-catalog';
import { AppError } from '@/lib/errors';
import { modelBankingData, modelToolError, parseModelToolError, toModelToolResult, toolFailure } from '@/agent/tools/result';

describe('model-facing banking results', () => {
  it('provides complete structured facts in content rather than relying on UI-only details', () => {
    const text = 'A complete archived conversation.'.repeat(300);
    const data = { id: 'business-id', amount: '92233720368547758.07', text };
    const result = toModelToolResult({ ok: true, summary: 'Recorded result.', data });
    expect(result.details).toBe(data);
    expect(JSON.parse(result.content[1].type === 'text' ? result.content[1].text : '')).toEqual({ ok: true, data });
    expect(result.isError).toBeUndefined();
  });

  it('preserves exact values and resource IDs while withholding credentials and execution identities', () => {
    expect(modelBankingData({ id: 'card-id', userId: 'owner', idempotencyKey: 'execution',
      amount: 9223372036854775807n, phone: '13912340002', apiKey: 'secret',
      nested: { dispatchTaskId: 'internal-workflow', dispatchError: 'private SQL trace', status: 'FAILED' } }))
      .toEqual({ id: 'card-id', amount: '9223372036854775807', phone: '139****0002', apiKey: '[REDACTED]', nested: { status: 'FAILED' } });
  });

  it('reports domain failures as native Pi errors with explicit next actions', async () => {
    const failure = toolFailure(new AppError('INSUFFICIENT_FUNDS', 'Insufficient funds.'));
    const call = fauxToolCall('failed_tool', {});
    const tool = { name: call.name, label: 'Failure', description: 'Failure fixture',
      parameters: { type: 'object', properties: {} }, execute: async () => toModelToolResult(failure) };
    const outcome = await runToolCall(call, { assistantMessage: fauxAssistantMessage([call]),
      tools: [tool], context: { messages: [], tools: [tool] } });
    expect(outcome.isError).toBe(true);
    const text = outcome.result.content[0];
    expect(parseModelToolError(text.type === 'text' ? text.text : '')).toEqual(failure);
    expect(text.type === 'text' && JSON.parse(text.text).bankingError.retryable).toBe(false);
  });

  it('does not turn infrastructure diagnostics into model-visible error messages', () => {
    const failure = toolFailure(new Error('private SQL query /secret/path api_key=secret'));
    const output = toModelToolResult(failure);
    expect(JSON.stringify(output)).not.toContain('private SQL');
    expect(JSON.stringify(output)).not.toContain('/secret/path');
    expect(output.details).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });

  it('retains safe disambiguation candidates without exposing arbitrary exception details', () => {
    const text = modelToolError(new AppError('CONFLICT', 'Choose one recipient.', { candidates: [
      { id: 'contact', name: 'Alice', phone: '13912340002', bank: 'Demo Bank', userId: 'private', newPassword: 'secret' },
    ], stack: 'private trace' }));
    expect(JSON.parse(text).bankingError.details).toEqual({ candidates: [{ id: 'contact', name: 'Alice', phone: '139****0002', bank: 'Demo Bank' }] });
    expect(text).not.toContain('private');
    expect(text).not.toContain('secret');
  });

  it('keeps partial workflow outcomes visible without describing them as fully successful', () => {
    const output = toModelToolResult({ ok: false, errorCode: 'TOOL_FAILED', error: 'A node failed.',
      data: { id: 'plan', status: 'failed', results: [{ id: 'first', status: 'success' }, { id: 'second', status: 'failed' }] } });
    expect(output.isError).toBe(true);
    const text = output.content[0];
    expect(text.type === 'text' && JSON.parse(text.text).bankingError.data.results).toHaveLength(2);
  });

  it.each(['Validation failed in a previous example.', '{"bankingError":"quoted"}', '{"bankingError":{"code":"unknown","message":"text"}}'])
  ('does not infer typed failure from arbitrary wording or malformed envelopes: %s', text => {
    expect(parseModelToolError(text)).toBeUndefined();
  });
});

describe('every registered capability rejects unknown model parameters', () => {
  const registry = createToolRegistry('fixture-owner');
  it.each(AGENT_TOOL_NAMES)('rejects unsupported arguments before %s reaches persistence', async name => {
    expect(await registry.executeDirect(name, { unsupportedArgument: true })).toMatchObject({ ok: false, errorCode: 'VALIDATION' });
    const tool = registry.get(name);
    const call = fauxToolCall(name, { unsupportedArgument: true });
    const outcome = await runToolCall(call, { assistantMessage: fauxAssistantMessage([call]), tools: [tool], context: { messages: [], tools: [tool] } });
    expect(outcome.isError).toBe(true);
    const text = outcome.result.content[0];
    expect(parseModelToolError(text.type === 'text' ? text.text : '')?.errorCode).toBe('VALIDATION');
  });
});
