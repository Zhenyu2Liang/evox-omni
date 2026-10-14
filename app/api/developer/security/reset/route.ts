import type { NextRequest } from 'next/server';
import { security } from '@/security';
import { requireDeveloperMode } from '../../../_lib/developer';
import { requireIdentity } from '../../../_lib/session';
import { errorResponse, jsonResponse } from '../../../_lib/http';

/** Demo maintenance resets the breaker without authorizing any pending banking operation. */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    requireDeveloperMode(request);
    const identity = await requireIdentity(request);
    const state = await security.circuitBreaker.resetDemoSession(identity.sessionId);
    return jsonResponse(state);
  } catch (error) {
    return errorResponse(error);
  }
}
