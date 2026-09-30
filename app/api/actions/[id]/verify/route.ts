/**
 * POST /api/actions/[id]/verify — submit the MFA code for a RED pending action.
 *
 * Contract:
 *  - Body: `{ code: string }` (validated with `mfaVerifySchema`).
 *  - Delegates to the agent runtime `verify(actionId, code, onEvent?)` (`@/agent`), which checks
 *    the code against the mock MFA value and, on success, executes the original validated args.
 *  - A WRONG code is a NORMAL 200 with `data.ok === false` and `data.status === 'awaiting_mfa'`
 *    (`mfaResult: 'failed'`); three consecutive failures trip the circuit breaker (`423`).
 *  - The MFA code is NEVER echoed back in any response body (only `mfaResult` is reported).
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
// Agent runtime contract (owner: `@/agent`).
import { verify } from '@/agent';
import type { ActionResponse, IdRouteContext } from '../../_lib/types';

/** Request body schema for `POST /api/actions/[id]/verify`. */
export const mfaVerifySchema = z.object({
  code: z.string().min(1),
});
export type MfaVerifyBody = z.infer<typeof mfaVerifySchema>;

export async function POST(_req: NextRequest, _ctx: IdRouteContext): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void verify;
export type { ActionResponse };
