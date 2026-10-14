import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels, fauxAssistantMessage, fauxToolCall, normalizeContext, type Message, type Models } from '@earendil-works/pi-ai';
import { createLiveRuntime } from '@/agent/providers/provider-live';
import { createMockRuntime } from '@/agent/providers/provider-mock';
import { withRealToolResult } from '@/agent/message-normalize';
import type { AppConfig } from '@/lib/config';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>();
  return { ...actual, createModels: vi.fn(actual.createModels) };
});

const live: AppConfig = {
  llmMode: 'live', llmProvider: 'deepseek', llmModel: 'deepseek-flash', demoUserId: 'user_liming',
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function response(): Response {
  const chunk = { id: 'offline-response', object: 'chat.completion.chunk', model: 'deepseek-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content: '已完成。' }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('Pi 1.x explicit provider runtime', () => {
  it('registers only the selected provider in the live collection', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'offline-deepseek-key');
    createLiveRuntime(live);
    const collection = vi.mocked(createModels).mock.results.at(-1)?.value as Models;
    expect(collection.getProviders().map(provider => provider.id)).toEqual(['deepseek']);
    expect(collection.getModel('deepseek', 'deepseek-flash')?.baseUrl).toBe('https://api.deepseek.com');
    expect(collection.getProvider('google')).toBeUndefined();
    expect(collection.getProvider('openai')).toBeUndefined();
  });

  it('runs independent mock Agents without network or a global provider registration', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('mock must stay offline'));
    // Each Agent gets its own stream collection, even though faux model ids match.
    const one = createMockRuntime({ ...live, llmMode: 'mock' });
    const two = createMockRuntime({ ...live, llmMode: 'mock' });
    const agents = [one, two].map(({ model, streamFn }) => new Agent({ initialState: { model }, streamFn }));
    await Promise.all(agents.map((agent) => agent.prompt('你好')));
    for (const agent of agents) {
      const last = agent.state.messages.at(-1);
      expect(last?.role).toBe('assistant');
      expect(last && 'stopReason' in last ? last.stopReason : undefined).toBe('stop');
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('serializes a confirmed tool continuation through the real DeepSeek adapter', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'offline-deepseek-key');
    const runtime = createLiveRuntime(live);
    let payload: { model: string; messages: Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> } | undefined;
    let endpoint = '';
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      endpoint = request.url;
      expect(request.headers.get('authorization')).toBe('Bearer offline-deepseek-key');
      payload = await request.json();
      return response();
    };
    const call = fauxAssistantMessage([fauxToolCall('transfer_money', { amount: '200.37' }, { id: 'transfer-1' })], { stopReason: 'toolUse' });
    const messages: Message[] = withRealToolResult([
      { role: 'user', content: '给张伟转200.37元', timestamp: 1 }, call,
      { role: 'toolResult', toolCallId: 'transfer-1', toolName: 'transfer_money', content: [{ type: 'text', text: '等待确认' }], isError: true, timestamp: 2 },
      fauxAssistantMessage('请确认。'),
    ], {
      role: 'toolResult', toolCallId: 'transfer-1', toolName: 'transfer_money',
      content: [{ type: 'text', text: '已入账200.37元' }], details: { amount: '200.37' }, isError: false, timestamp: 3,
    }) as Message[];
    const stream = await runtime.streamFn(runtime.model, normalizeContext({ messages }), { fetch, maxRetries: 0 });
    const result = await stream.result();
    expect(result.stopReason).toBe('stop');
    expect(endpoint).toBe('https://api.deepseek.com/chat/completions');
    expect(payload?.model).toBe('deepseek-flash');
    const toolIndex = payload!.messages.findIndex((message) => message.role === 'tool');
    expect(toolIndex).toBeGreaterThan(0);
    expect(payload!.messages.filter((message) => message.role === 'tool')).toHaveLength(1);
    expect(payload!.messages[toolIndex - 1].tool_calls?.map((call) => call.id))
      .toContain(payload!.messages[toolIndex].tool_call_id);
  });

  it('registers and authenticates a custom OpenAI-compatible provider on its configured host', async () => {
    vi.stubEnv('LLM_BASE_URL', 'https://local-provider.test/v1');
    vi.stubEnv('LOCAL_PROVIDER_API_KEY', 'offline-custom-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createLiveRuntime({ ...live, llmProvider: 'local-provider', llmModel: 'custom-chat' });
    let endpoint = '';
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      endpoint = request.url;
      expect(request.headers.get('authorization')).toBe('Bearer offline-custom-key');
      return response();
    };
    const stream = await runtime.streamFn(runtime.model, normalizeContext({
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
    }), { fetch, maxRetries: 0 });
    expect((await stream.result()).stopReason).toBe('stop');
    expect(endpoint).toBe('https://local-provider.test/v1/chat/completions');
  });
});
