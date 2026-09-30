/**
 * GET /api/health — liveness probe + runtime mode.
 *
 * Contract:
 *  - Success: `200 { ok: true, data: { status: 'ok', time: number, llmMode: 'live' | 'mock' } }`.
 *  - `llmMode` is read from `getConfig().llmMode` (never hard-coded) so the demo can be probed
 *    for whether it is running the live model or the deterministic faux provider.
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import { AppError } from '@/lib/errors';

/** Response payload for `GET /api/health`. */
export interface HealthData {
  status: 'ok';
  /** Epoch ms. */
  time: number;
  llmMode: 'live' | 'mock';
}

export async function GET(): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}
