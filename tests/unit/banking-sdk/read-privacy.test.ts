import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({ listAccounts: vi.fn(), searchContacts: vi.fn() }));
vi.mock('@/lib/db/repositories', () => ({
  accounts: { listAccounts: repository.listAccounts },
  contacts: { searchContacts: repository.searchContacts },
}));
vi.mock('@/banking-sdk/tx', () => ({ runInTransaction: async (callback: () => unknown) => callback() }));

import { getBalance } from '@/banking-sdk/account';
import { searchContacts } from '@/banking-sdk/contact';

describe('public banking read projections', () => {
  beforeEach(() => vi.resetAllMocks());

  it('masks stored account identifiers and omits owner fields from balance results', async () => {
    repository.listAccounts.mockResolvedValue([
      { id: 'owned-account', userId: 'owner', type: 'CHECKING', name: 'Checking',
        number: '6222001234568821', balanceMinor: 105n, currency: 'CNY' },
    ]);
    const result = await getBalance('owner');
    expect(repository.listAccounts).toHaveBeenCalledWith('owner');
    expect(result.totalAvailable).toBe('1.05');
    expect(result.accounts[0]).toMatchObject({ id: 'owned-account', numberMasked: '****8821' });
    expect(result.accounts[0]).not.toHaveProperty('userId');
    expect(JSON.stringify(result)).not.toContain('6222001234568821');
  });

  it('returns masked contact candidates from an owner-scoped trimmed search', async () => {
    repository.searchContacts.mockResolvedValue([
      { id: 'owned-contact', userId: 'owner', name: 'Alex', phone: '13912340002', bank: 'Demo Bank', remark: null },
    ]);
    const results = await searchContacts('owner', '  Alex  ');
    expect(repository.searchContacts).toHaveBeenCalledWith('owner', 'Alex');
    expect(results[0]).toMatchObject({ id: 'owned-contact', phone: '139****0002' });
    expect(results[0]).not.toHaveProperty('userId');
    expect(JSON.stringify(results)).not.toContain('13912340002');
  });

  it('rejects invalid contact text before repository access', async () => {
    await expect(searchContacts('owner', 'x'.repeat(257))).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(searchContacts('owner', 'Al\nex')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(repository.searchContacts).not.toHaveBeenCalled();
  });
});
