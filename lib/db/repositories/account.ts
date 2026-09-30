import type { Account } from '@prisma/client';

export function listAccounts(userId: string): Promise<Account[]> {
  throw new Error('not implemented');
}

export function getAccount(id: string): Promise<Account | null> {
  throw new Error('not implemented');
}

export function getCheckingAccount(userId: string): Promise<Account | null> {
  throw new Error('not implemented');
}

export function getTotalBalance(userId: string): Promise<number> {
  throw new Error('not implemented');
}

export function createAccount(input: { userId: string; type: string; name: string; number: string; balance: number; currency?: string }): Promise<Account> {
  throw new Error('not implemented');
}

export function setBalance(id: string, balance: number): Promise<Account> {
  throw new Error('not implemented');
}

export function incrementBalance(id: string, delta: number): Promise<Account> {
  throw new Error('not implemented');
}
