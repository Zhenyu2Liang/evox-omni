import { expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, normalizeContext } from '@earendil-works/pi-ai';
import { MODEL_BUDGET_MESSAGE, withModelBudget, type ModelBudgetState } from './model-budget';

function harness(settings = { maxRequests: 2, maxTokens: 1000000, maxDurationMs: 30000 }) {
  const registration = fauxProvider();
  const models = createModels();
  models.setProvider(registration.provider);
  registration.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage('hello')));
  let state: ModelBudgetState | undefined;
  let intentId = 'turn-1';
  const options = { config: { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'user_liming', modelBudget: settings },
    state: () => state, intentId: () => intentId,
    save: async (value: ModelBudgetState) => { state = JSON.parse(JSON.stringify(value)); } };
  return { model: registration.getModel(), base: models.streamSimple.bind(models), options,
    state: () => state, nextTurn: () => { intentId = 'turn-2'; }, calls: () => registration.state.callCount };
}

it('persists reservations before requests and shares the request limit across rebuilt runtimes', async () => {
  const h = harness();
  const first = withModelBudget(h.base, h.options);
  await (await first(h.model, normalizeContext({ messages: [] }))).result();
  const restored = withModelBudget(h.base, h.options);
  await (await restored(h.model, normalizeContext({ messages: [] }))).result();
  await expect(restored(h.model, normalizeContext({ messages: [] }))).rejects.toThrow(MODEL_BUDGET_MESSAGE);
  expect(h.state()?.requests).toBe(2);
  expect(h.calls()).toBe(2);
  h.nextTurn();
  await (await restored(h.model, normalizeContext({ messages: [] }))).result();
  expect(h.state()?.requests).toBe(1);
});

it('rejects an input which cannot fit the remaining token reservation without calling the provider', async () => {
  const h = harness({ maxRequests: 10, maxTokens: 1000, maxDurationMs: 30000 });
  await expect(withModelBudget(h.base, h.options)(h.model, normalizeContext({ messages: [] }))).rejects.toThrow(MODEL_BUDGET_MESSAGE);
  expect(h.calls()).toBe(0);
});

it('ends even a provider which ignores cancellation at the persisted turn deadline', async () => {
  const h = harness({ maxRequests: 10, maxTokens: 1000000, maxDurationMs: 30 });
  const stream = withModelBudget(() => new Promise(() => {}), h.options);
  const result = await (await stream(h.model, normalizeContext({ messages: [] }))).result();
  expect(result.stopReason).toBe('aborted');
  expect(result.errorMessage).toBe(MODEL_BUDGET_MESSAGE);
  await new Promise(resolve => setTimeout(resolve, 5));
  await expect(withModelBudget(h.base, h.options)(h.model, normalizeContext({ messages: [] }))).rejects.toThrow(MODEL_BUDGET_MESSAGE);
  expect(h.calls()).toBe(0);
});

it('charges provider HTTP retries against the same request limit', async () => {
  const h = harness({ maxRequests: 1, maxTokens: 1000000, maxDurationMs: 30000 });
  let fetches = 0;
  const stream = withModelBudget(async (model, context, options) => {
    await options?.fetch?.('https://unused.invalid/');
    await options?.fetch?.('https://unused.invalid/');
    return h.base(model, context, options);
  }, h.options);
  const result = await (await stream(h.model, normalizeContext({ messages: [] }), { fetch: async () => {
    fetches++;
    return new Response('{}', { status: 503 });
  } })).result();
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toBe(MODEL_BUDGET_MESSAGE);
  expect(fetches).toBe(1);
  expect(h.state()?.requests).toBe(1);
  expect(h.calls()).toBe(0);
});
