import type { Contact } from '@/lib/db/prisma';
import { createHash } from 'node:crypto';
import { dbClient } from '../client';
import { isCompletePhone, phoneCandidateMatches, type PhoneCandidate } from '../../phone';

/**
 * The phone facets of a stored contact, shaped for `lib/phone`.
 *
 * `Contact.phone` is the PUBLIC display value (masked for seeded/history rows, complete for rows
 * created through the HTTP API) while `Contact.phoneFull` holds the complete number for
 * SERVER-SIDE exact matching only and is never projected to a caller. Feeding both to the phone
 * helpers keeps every caller consistent: an identity can only ever come from a complete number,
 * while a mask stays a candidate narrowing.
 */
export function contactPhoneFacets(contact: Pick<Contact, 'phone' | 'phoneFull'>): PhoneCandidate {
  return { full: contact.phoneFull ?? null, display: contact.phone };
}

export function listContacts(userId: string): Promise<Contact[]> {
  return dbClient().contact.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
  });
}

/** Serialize recipient edits before reading duplicate candidates in SQLite. */
export async function lockContactOwner(userId: string): Promise<boolean> {
  const locked = await dbClient().user.updateMany({ where: { id: userId }, data: { id: userId } });
  return locked.count === 1;
}

export function getContact(id: string): Promise<Contact | null> {
  return dbClient().contact.findUnique({ where: { id } });
}

export function getContactByName(userId: string, name: string): Promise<Contact | null> {
  return dbClient().contact.findFirst({
    where: { userId, name },
    orderBy: { id: 'asc' },
  });
}

/**
 * Contacts whose name or phone CANDIDATE-matches `keyword`.
 *
 * A hit means "maybe this contact", never "this is the recipient": a masked or fragment phone only
 * narrows the list (`phoneCandidateMatches`), so a transfer recipient must still be established by an
 * exact identity check (complete number / contact id / exact name) or by a UNIQUE candidate. The
 * stored complete number (`phoneFull`) takes part in the narrowing, so a complete query is not
 * degraded to the mask's visible ends. An empty keyword returns all owned contacts.
 */
export function searchContacts(userId: string, keyword: string): Promise<Contact[]> {
  const needle = keyword.toLowerCase();
  return dbClient().contact
    .findMany({ where: { userId }, orderBy: { name: 'asc' } })
    .then((contacts) =>
      contacts.filter(
        (contact) =>
          contact.name.toLowerCase().includes(needle) ||
          phoneCandidateMatches(keyword, contactPhoneFacets(contact)),
      ),
    );
}

export function createContact(input: { userId: string; name: string; phone: string; bank?: string | null; remark?: string | null }): Promise<Contact> {
  // The normalized phone identifies a saved recipient even if two requests race.
  const id = `contact_${createHash('sha256').update(JSON.stringify([input.userId, input.phone])).digest('hex')}`;
  return dbClient().contact.create({
    data: {
      id,
      userId: input.userId,
      name: input.name,
      phone: input.phone,
      // The complete number also lands in the SERVER-ONLY column, so identity checks never depend on
      // which column happens to hold the full value (see `contactPhoneFacets`).
      phoneFull: isCompletePhone(input.phone) ? input.phone : null,
      ...(input.bank !== undefined ? { bank: input.bank } : {}),
      ...(input.remark !== undefined ? { remark: input.remark } : {}),
    },
  });
}

export async function deleteContact(userId: string, id: string): Promise<boolean> {
  const deleted = await dbClient().contact.deleteMany({ where: { userId, id } });
  return deleted.count === 1;
}
