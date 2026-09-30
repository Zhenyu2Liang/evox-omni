/**
 * Banking SDK — contact reads. GREEN tier (auto-execute).
 */
import type { ContactView } from './types';

/** Contacts matching `query` by name (substring) or phone (substring). */
export async function searchContacts(userId: string, query: string): Promise<ContactView[]> {
  throw new Error('not implemented');
}

/** A single contact by id. Throws `AppError('NOT_FOUND')` when missing. */
export async function getContact(userId: string, id: string): Promise<ContactView> {
  throw new Error('not implemented');
}

/** All contacts owned by the user. */
export async function listContacts(userId: string): Promise<ContactView[]> {
  throw new Error('not implemented');
}
