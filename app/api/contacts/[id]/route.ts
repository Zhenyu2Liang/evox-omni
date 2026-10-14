import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { errorResponse, jsonResponse, parseBody } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';
import { deleteSavedContact } from '../../_lib/contact-management';

const deletionSchema = z.object({ confirm: z.literal(true) }).strict();

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await parseBody(deletionSchema, req);
    const identity = await requireIdentity(req);
    const { id } = await context.params;
    return jsonResponse({ contact: await deleteSavedContact(identity, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
