import type { Contact } from '@prisma/client';

export function listContacts(userId: string): Promise<Contact[]> {
  throw new Error('not implemented');
}

export function getContact(id: string): Promise<Contact | null> {
  throw new Error('not implemented');
}

export function getContactByName(userId: string, name: string): Promise<Contact | null> {
  throw new Error('not implemented');
}

export function searchContacts(userId: string, keyword: string): Promise<Contact[]> {
  throw new Error('not implemented');
}

export function createContact(input: { userId: string; name: string; phone: string; bank?: string | null; remark?: string | null }): Promise<Contact> {
  throw new Error('not implemented');
}
