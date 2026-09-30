/**
 * Banking SDK — contact reads. GREEN tier (auto-execute).
 */
import type { Contact } from '@prisma/client';
import { contacts } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import type { ContactView } from './types';

/** Map a persisted `Contact` row onto the public `ContactView` view model. */
export function toContactView(row: Contact): ContactView {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    bank: row.bank ?? undefined,
    remark: row.remark ?? undefined,
  };
}

/** Contacts matching `query` by name (substring) or phone (substring). */
export async function searchContacts(userId: string, query: string): Promise<ContactView[]> {
  const rows = await contacts.searchContacts(userId, query);
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
