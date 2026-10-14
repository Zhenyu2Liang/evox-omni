import { createModels, fauxProvider, type Model } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import type { AppConfig } from '@/lib/config';
import { respondWithGuidance } from './mock-responder';
import type { ModelRuntime } from './types';
import { mockCompactionReply } from './mock/compaction';

/**
 * MOCK mode — builds a fully OFFLINE, DETERMINISTIC scripted model.
 *
 * Builds an isolated in-memory provider collection via `fauxProvider()` from
 * `@earendil-works/pi-ai` and drives it with the pure decision function in
 * `./mock-responder`. The same Agent / tools / security pipeline runs unchanged —
 * only the model is scripted. This drives `LLM_MODE=mock` and every agent test, so it
 * MUST perform no network I/O and MUST be reproducible across runs.
 *
 * The faux provider consumes exactly ONE queued step per model call. The queued step is
 * a FACTORY that re-queues itself (`appendResponses([factory])`) before answering, so the
 * model never runs out of responses across the multiple calls of a single agent turn
 * (prompt → tool result → narration). Because no `tokensPerSecond` is configured, text
 * deltas are emitted on the microtask queue (no variable timers) — determinism holds.
 */
export function createMockRuntime(_cfg: AppConfig): ModelRuntime {
  // Models collections are isolated; a stable API identity lets a fresh process recover this demo model.
  const reg = fauxProvider({ api: 'banking-demo-mock' });
  const models = createModels();
  models.setProvider(reg.provider);
  const factory = (context: Context, options?: { maxTokens?: number }): ReturnType<typeof respondWithGuidance> => {
    reg.appendResponses([factory]); // re-queue: one step consumed per model call
    return mockCompactionReply(context, options?.maxTokens) ?? respondWithGuidance(context);
  };
  reg.setResponses([factory]);
  return { model: reg.getModel(), streamFn: models.streamSimple.bind(models) };
}

/** Model-only facade retained for callers inspecting the selected model. */
export function createMockModel(cfg: AppConfig): Model<any> {
  return createMockRuntime(cfg).model;
}
