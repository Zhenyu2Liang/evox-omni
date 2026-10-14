import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { clearedConversationState, getDemoSession } from '@/agent/session';
import { resetConversation } from '@/lib/db/repositories/session';
import { AppError } from '@/lib/errors';
import { requireIdentity } from '../../../_lib/session';
import { requireDeveloperMode } from '../../../_lib/developer';
import { errorResponse, jsonResponse, parseBody } from '../../../_lib/http';

const resetSchema = z.object({ expectedRevision: z.number().int().nonnegative(), confirm: z.literal(true) }).strict();

export async function POST(request: NextRequest): Promise<Response> {
  try {
    requireDeveloperMode(request);
    const payload = await parseBody(resetSchema, request);
    const identity = await requireIdentity(request);
    const snapshot = await getDemoSession(identity.userId);
    if (snapshot.revision !== payload.expectedRevision) throw new AppError('CONFLICT', 'The conversation changed. Refresh before clearing it.');
    await resetConversation({ ...identity, expectedRevision: payload.expectedRevision, stateJson: clearedConversationState(snapshot) });
    return jsonResponse({ revision: payload.expectedRevision + 1 });
  } catch (error) { return errorResponse(error); }
}
