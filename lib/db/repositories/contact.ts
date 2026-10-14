import type { Contact } from '@/lib/db/prisma';
import { createHash } from 'node:crypto';
import { dbClient } from '../client';
import { searchPhoneMatch } from '../../phone';

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
 * Contacts whose name or phone matches `keyword`.
 *
 * Stored `Contact.phone` values are MASKED (e.g. `139****0002`) while a transfer recipient may be typed
 * as a RAW number (e.g. `13900000002`). Search returns candidate names or phone fragments;
 * executable transfers separately bind a complete phone identity or exact contact ID/name.
 * An empty keyword returns all owned contacts.
 */
export function searchContacts(userId: string, keyword: string): Promise<Contact[]> {
  const needle = keyword.toLowerCase();
  return dbClient().contact
    .findMany({ where: { userId }, orderBy: { name: 'asc' } })
    .then((contacts) =>
      contacts.filter(
        (contact) =>
          contact.name.toLowerCase().includes(needle) ||
          searchPhoneMatch(keyword, contact.phone),
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
      ...(input.bank !== undefined ? { bank: input.bank } : {}),
      ...(input.remark !== undefined ? { remark: input.remark } : {}),
    },
  });
}

export async function deleteContact(userId: string, id: string): Promise<boolean> {
  const deleted = await dbClient().contact.deleteMany({ where: { userId, id } });
  return deleted.count === 1;
}
