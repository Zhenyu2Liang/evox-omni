import type { NextRequest } from 'next/server';
import { banking } from '@/banking-sdk';
import { contactInputSchema } from '@/banking-sdk/contact';
import { errorResponse, jsonResponse, parseBody } from '../_lib/http';
import { requireIdentity } from '../_lib/session';
import { addSavedContact } from '../_lib/contact-management';

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const { userId } = await requireIdentity(req);
    return jsonResponse({ contacts: await banking.contact.listContacts(userId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const input = await parseBody(contactInputSchema, req);
    const identity = await requireIdentity(req);
    return jsonResponse({ contact: await addSavedContact(identity, input) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
