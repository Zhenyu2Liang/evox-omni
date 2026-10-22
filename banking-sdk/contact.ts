/**
 * Banking SDK — contact reads. GREEN tier (auto-execute).
 */
import type { Contact } from '@/lib/db/prisma';
import { contacts } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import type { ContactView } from './types';
import { z } from 'zod';
import { contactPhoneFacets } from '../lib/db/repositories/contact';
import { maskPhone, phoneIdentityMatches } from '../lib/phone';
import { runInTransaction } from './tx';

const contactText = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]*$/);
const contactQuery = z.string().trim().max(256).regex(/^[^\u0000-\u001f\u007f]*$/);
export const contactInputSchema = z.object({
  name: contactText,
  phone: z.string().trim().regex(/^1[3-9]\d{9}$/),
  bank: contactText.optional(),
  remark: z.string().trim().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).strict();
export type ContactInput = z.infer<typeof contactInputSchema>;

/** Map a persisted `Contact` row onto the public `ContactView` view model. */
export function toContactView(row: Contact): ContactView {
  return {
    id: row.id,
    name: row.name,
    phone: maskPhone(row.phone),
    bank: row.bank ?? undefined,
    remark: row.remark ?? undefined,
  };
}

/** Contacts matching `query` by name (substring) or phone (substring). */
export async function searchContacts(userId: string, query: string): Promise<ContactView[]> {
  const parsed = contactQuery.safeParse(query);
  if (!parsed.success) throw new AppError('VALIDATION', 'Contact search requires a text query of at most 256 characters without control characters.');
  const rows = await contacts.searchContacts(userId, parsed.data);
  return rows.map(toContactView);
}

/** A single contact by id. Throws `AppError('NOT_FOUND')` when missing. */
export async function getContact(userId: string, id: string): Promise<ContactView> {
  const row = await contacts.getContact(id);
  if (!row || row.userId !== userId) {
    throw new AppError('NOT_FOUND', `Contact ${id} not found for user ${userId}`);
  }
  return toContactView(row);
}

/** All contacts owned by the user. */
export async function listContacts(userId: string): Promise<ContactView[]> {
  const rows = await contacts.listContacts(userId);
  return rows.map(toContactView);
}

/** Full phones remain in storage for recipient resolution; public views are masked. */
export async function addContact(userId: string, input: ContactInput): Promise<ContactView> {
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Invalid contact details.');
  return runInTransaction(async () => {
    if (!await contacts.lockContactOwner(userId)) throw new AppError('NOT_FOUND', 'Contact owner does not exist.');
    const existing = await contacts.listContacts(userId);
    // IDENTITY, not mask matching: a saved recipient is the same person only when the complete
    // number is stored (`phoneFull`, or a legacy row that kept the full number in `phone`). A
    // history row that kept only a mask is never treated as the same number.
    if (existing.some(contact => phoneIdentityMatches(parsed.data.phone, contactPhoneFacets(contact)))) {
      throw new AppError('CONFLICT', 'A contact with this mobile number already exists.');
    }
    try {
      return toContactView(await contacts.createContact({ userId, ...parsed.data }));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        throw new AppError('CONFLICT', 'A contact with this mobile number already exists.');
      }
      throw error;
    }
  });
}

export async function removeContact(userId: string, id: string): Promise<ContactView> {
  return runInTransaction(async () => {
    if (!await contacts.lockContactOwner(userId)) throw new AppError('NOT_FOUND', 'Contact owner does not exist.');
    const contact = await getContact(userId, id);
    if (!await contacts.deleteContact(userId, id)) throw new AppError('NOT_FOUND', 'Contact no longer exists.');
    return contact;
  });
}
