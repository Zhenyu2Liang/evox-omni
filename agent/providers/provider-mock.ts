import { registerFauxProvider, type Model } from '@mariozechner/pi-ai';
import type { Context } from '@mariozechner/pi-ai';
import type { AppConfig } from '@/lib/config';
import { respond } from './mock-responder';

/**
 * MOCK mode — builds a fully OFFLINE, DETERMINISTIC scripted model.
 *
 * Registers the in-memory faux provider via `registerFauxProvider()` from
 * `@mariozechner/pi-ai` and drives it with the pure decision function in
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
export function createMockModel(_cfg: AppConfig): Model<any> {
  const reg = registerFauxProvider();
  const factory = (context: Context): ReturnType<typeof respond> => {
    reg.appendResponses([factory]); // re-queue: one step consumed per model call
    return respond(context);
  };
  reg.setResponses([factory]);
  return reg.getModel();
}
