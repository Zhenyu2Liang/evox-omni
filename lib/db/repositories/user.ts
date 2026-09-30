import type { User } from '@prisma/client';
import { prisma } from '../client';

export function getUser(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export function getUserByPhone(phone: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { phone } });
}

export function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
}

export function createUser(input: { id?: string; name: string; phone: string; avatarEmoji?: string | null }): Promise<User> {
  return prisma.user.create({
    data: {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      phone: input.phone,
      ...(input.avatarEmoji !== undefined ? { avatarEmoji: input.avatarEmoji } : {}),
    },
  });
}

export function updateUser(id: string, input: { name?: string; avatarEmoji?: string | null }): Promise<User> {
  return prisma.user.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.avatarEmoji !== undefined ? { avatarEmoji: input.avatarEmoji } : {}),
    },
  });
}
