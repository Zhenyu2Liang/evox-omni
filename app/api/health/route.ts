/**
 * GET /api/health — liveness probe + runtime mode.
 *
 * Contract:
 *  - Success: `200 { ok: true, data: { status: 'ok', time: number, llmMode: 'live' | 'mock' } }`.
 *  - `llmMode` is read from `getConfig().llmMode` (never hard-coded) so the demo can be probed
 *    for whether it is running the live model or the deterministic faux provider.
 */
import { getConfig } from '@/lib/config';
import { errorResponse, jsonResponse } from '../_lib/http';

/** Response payload for `GET /api/health`. */
export interface HealthData {
  status: 'ok';
  /** Epoch ms. */
  time: number;
  llmMode: 'live' | 'mock';
}

export async function GET(): Promise<Response> {
  try {
    const data: HealthData = { status: 'ok', time: Date.now(), llmMode: getConfig().llmMode };
    return jsonResponse(data);
  } catch (e) {
    return errorResponse(e);
  }
}
