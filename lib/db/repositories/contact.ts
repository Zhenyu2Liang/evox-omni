import type { Contact } from '@prisma/client';
import { prisma } from '../client';

export function listContacts(userId: string): Promise<Contact[]> {
  return prisma.contact.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
  });
}

export function getContact(id: string): Promise<Contact | null> {
  return prisma.contact.findUnique({ where: { id } });
}

export function getContactByName(userId: string, name: string): Promise<Contact | null> {
  return prisma.contact.findFirst({
    where: { userId, name },
    orderBy: { id: 'asc' },
  });
}

/** Contacts whose name or phone contains `keyword`. */
export function searchContacts(userId: string, keyword: string): Promise<Contact[]> {
  return prisma.contact.findMany({
    where: {
      userId,
      OR: [{ name: { contains: keyword } }, { phone: { contains: keyword } }],
    },
    orderBy: { name: 'asc' },
  });
}

export function createContact(input: { userId: string; name: string; phone: string; bank?: string | null; remark?: string | null }): Promise<Contact> {
  return prisma.contact.create({
    data: {
      userId: input.userId,
      name: input.name,
      phone: input.phone,
      ...(input.bank !== undefined ? { bank: input.bank } : {}),
      ...(input.remark !== undefined ? { remark: input.remark } : {}),
    },
  });
}
