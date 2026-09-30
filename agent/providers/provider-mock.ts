import { registerFauxProvider, type Model } from '@mariozechner/pi-ai';
import type { AppConfig } from '@/lib/config';

/**
 * MOCK mode — builds a fully OFFLINE, DETERMINISTIC scripted model.
 *
 * Registers the in-memory faux provider via `registerFauxProvider()` from
 * `@mariozechner/pi-ai` and returns its scripted `Model`. The same Agent / tools /
 * security pipeline runs unchanged — only the model is scripted. This drives
 * `LLM_MODE=mock` and every agent test, so it MUST perform no network I/O and MUST
 * be reproducible across runs.
 *
 * `registerFauxProvider()` with no options yields a single deterministic model
 * (`faux-1`) served entirely in-memory: no sockets, and — because no
 * `tokensPerSecond` is configured — text deltas are emitted on the microtask queue
 * (no variable timers). Scenario tests that need a scripted reply sequence register
 * their OWN faux provider and call `setResponses`; this factory only guarantees a
 * deterministic, offline faux model.
 */
export function createMockModel(_cfg: AppConfig): Model<any> {
  return registerFauxProvider().getModel();
}
