import type { User } from '@prisma/client';

export function getUser(id: string): Promise<User | null> {
  throw new Error('not implemented');
}

export function getUserByPhone(phone: string): Promise<User | null> {
  throw new Error('not implemented');
}

export function listUsers(): Promise<User[]> {
  throw new Error('not implemented');
}

export function createUser(input: { id?: string; name: string; phone: string; avatarEmoji?: string | null }): Promise<User> {
  throw new Error('not implemented');
}

export function updateUser(id: string, input: { name?: string; avatarEmoji?: string | null }): Promise<User> {
  throw new Error('not implemented');
}
