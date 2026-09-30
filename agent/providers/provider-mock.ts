import type { Model } from '@mariozechner/pi-ai';
import type { AppConfig } from '@/lib/config';

/**
 * MOCK mode — builds a fully OFFLINE, DETERMINISTIC scripted model.
 *
 * Registers the in-memory faux provider via `registerFauxProvider()` from
 * `@mariozechner/pi-ai` and returns its scripted `Model`. The same Agent / tools /
 * security pipeline runs unchanged — only the model is scripted. This drives
 * `LLM_MODE=mock` and every agent test, so it MUST perform no network I/O and MUST
 * be reproducible across runs.
 */
export function createMockModel(cfg: AppConfig): Model {
  throw new Error('not implemented');
}
