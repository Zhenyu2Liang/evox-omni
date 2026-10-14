import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => [{ id: 'contact-one', name: 'Alice', phone: '139****0002' }, { id: 'contact-two', name: 'Bob', phone: '139****0003' }]);
vi.mock('@/lib/db/repositories/contact', () => ({ listContacts: vi.fn(async () => rows) }));
vi.mock('@/lib/db/repositories/account', () => ({ getAccount: vi.fn() }));

import { resolveTransferRecipient } from '@/security/recipient-resolution';

describe('recipient identity fields', () => {
  it.each([{ contactId: 'contact-one' }, { name: 'Alice' }, { phone: '13900000002' }])('binds the declared identity field %j', async args => {
    expect(await resolveTransferRecipient('owner', args)).toMatchObject({ status: 'resolved', contact: { id: 'contact-one' } });
  });

  it.each([{ contactId: 'Alice' }, { name: 'contact-one' }, { phone: '0002' }, { phone: 'Alice' }])('rejects cross-field and partial aliases %j', async args => {
    expect(await resolveTransferRecipient('owner', args)).toMatchObject({ status: 'not_found' });
  });

  it('requires every supplied identity field to refer to the same saved contact', async () => {
    expect(await resolveTransferRecipient('owner', { contactId: 'unknown', name: 'Alice' })).toMatchObject({ status: 'not_found' });
    expect(await resolveTransferRecipient('owner', { contactId: 'contact-one', name: 'Bob' })).toMatchObject({ status: 'not_found' });
    expect(await resolveTransferRecipient('owner', { contactId: 'contact-one', name: 'Alice' })).toMatchObject({ status: 'resolved', contact: { id: 'contact-one' } });
  });
});
