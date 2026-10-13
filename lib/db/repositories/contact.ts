import type { Contact } from '@prisma/client';
import { dbClient } from '../client';
import { maskAwarePhoneMatch } from '../../phone';

export function listContacts(userId: string): Promise<Contact[]> {
  return dbClient().contact.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
  });
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
 * as a RAW number (e.g. `13900000002`), which never substring-matches the masked value in SQL. So the
 * caller's contacts are loaded and matched IN MEMORY: name substring (case-insensitive, as the previous
 * SQLite `contains` was) OR a mask-aware phone match (`../../phone`). An empty keyword matches every name,
 * preserving the previous "return all contacts" behaviour.
 */
export function searchContacts(userId: string, keyword: string): Promise<Contact[]> {
  const needle = keyword.toLowerCase();
  return dbClient().contact
    .findMany({ where: { userId }, orderBy: { name: 'asc' } })
    .then((contacts) =>
      contacts.filter(
        (contact) =>
          contact.name.toLowerCase().includes(needle) ||
          maskAwarePhoneMatch(keyword, contact.phone),
      ),
    );
}

export function createContact(input: { userId: string; name: string; phone: string; bank?: string | null; remark?: string | null }): Promise<Contact> {
  return dbClient().contact.create({
    data: {
      userId: input.userId,
      name: input.name,
      phone: input.phone,
      ...(input.bank !== undefined ? { bank: input.bank } : {}),
      ...(input.remark !== undefined ? { remark: input.remark } : {}),
    },
  });
}
