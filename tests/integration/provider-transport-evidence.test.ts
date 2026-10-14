import { describe, expect, it } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { withLiveRequestLimits } from '@/agent/providers/request-options';
import { runTurn } from '@/agent/run-turn';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';

useFreshDatabase();
const model = deepseekProvider().getModels().find(candidate => candidate.id === 'deepseek-flash')!;
const config = { llmMode: 'live' as const, llmProvider: 'deepseek', llmModel: model.id, demoUserId: 'user_liming' };

function runtime(wire: string) {
  const fetch: typeof globalThis.fetch = async () => new Response(wire, { headers: {
    'content-type': 'text/event-stream', 'x-request-id': 'offline-request-1', 'set-cookie': 'private-cookie',
  } });
  const sdk = streamSimple as StreamFn;
  const guarded = withLiveRequestLimits(sdk);
  const stream: StreamFn = (current, context, options) => guarded(current, context, { ...options, apiKey: 'offline-key', fetch });
  return { model, streamFn: stream };
}

describe('wire evidence, Pi normalization and durable result completion share one request identity', () => {
  it('preserves and traces a provider-declared complete reply without linguistic guesses or repair', async () => {
    const raw = { id: 'completion-1', object: 'chat.completion.chunk', model: model.id,
      choices: [{ index: 0, delta: { content: 'A short reply\n\nFor' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 26, total_tokens: 31 } };
    const response = await runTurn({ message: 'Explain which account funds a transfer.' }, {
      config, provider: runtime(`data: ${JSON.stringify(raw)}\n\ndata: [DONE]\n\n`),
    });
    expect(response.events.some(event => event.type === 'text_delta' && event.delta === 'A short reply\n\nFor')).toBe(true);
    const db = getTestPrisma();
    const requests = await db.modelRequest.findMany();
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('completed');
    const evidence = (await db.agentRunEvent.findMany({ where: { eventType: { startsWith: 'provider_' } }, orderBy: { sequence: 'asc' } }))
      .map(event => ({ type: event.eventType, ...JSON.parse(event.payloadJson) }));
    expect(evidence.every(event => event.modelRequestId === requests[0].id)).toBe(true);
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'provider_request_payload', payload: expect.objectContaining({ stream: true }) }),
      expect.objectContaining({ type: 'provider_response_event', payload: raw }),
      expect.objectContaining({ type: 'provider_response_event', payload: expect.objectContaining({ completed: true, terminator: '[DONE]' }) }),
    ]));
    expect(JSON.stringify(evidence)).not.toContain('private-cookie');
    expect(JSON.stringify(evidence)).not.toContain('offline-key');
  });

  it('does not admit or execute a proposed write after finish_reason when transport is incomplete', async () => {
    const raw = { id: 'completion-2', object: 'chat.completion.chunk', model: model.id,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'freeze-1', type: 'function',
        function: { name: 'freeze_card', arguments: '{"cardId":"card_credit"}' } }] }, finish_reason: 'tool_calls' }] };
    const response = await runTurn({ message: 'Freeze my credit card.' }, {
      config, provider: runtime(`data: ${JSON.stringify(raw)}\n\n`),
    });
    const db = getTestPrisma();
    expect(response.events.some(event => event.type === 'tool_start' || event.type === 'mfa_required' || event.type === 'confirmation_required')).toBe(false);
    expect(await db.pendingAction.count()).toBe(0);
    expect(await db.toolInvocation.count()).toBe(0);
    expect(await db.executionReceipt.count()).toBe(0);
    expect((await db.card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status).toBe('ACTIVE');
    const requests = await db.modelRequest.findMany();
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe('failed');
    expect(requests[0].resultJson).toBeNull();
    const events = await db.agentRunEvent.findMany({ where: { eventType: 'message_end' } });
    expect(events.some(event => event.payloadJson.includes('without the required [DONE] terminator'))).toBe(true);
  });
});
