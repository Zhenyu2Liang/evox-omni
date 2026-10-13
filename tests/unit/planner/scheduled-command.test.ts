import { describe, expect, it } from 'vitest';
import { scheduledTransferArgs } from '@/agent/scheduled-command';

describe('scheduled payment compilation', () => {
  it('preserves exact decimal text and explicitly provided recipient selectors', () => {
    expect(scheduledTransferArgs('TRANSFER', { contactId: 'contact', amount: '90071992547409.01' }))
      .toEqual({ contactId: 'contact', amount: '90071992547409.01' });
  });

  it('requires the current recipient field for a scheduled payment', () => {
    expect(() => scheduledTransferArgs('PAYMENT', { toName: 'Landlord', amount: '200.00' }))
      .toThrow('requires an explicit recipient');
    expect(scheduledTransferArgs('PAYMENT', { name: 'Landlord', amount: '200.00' }))
      .toEqual({ name: 'Landlord', amount: '200.00' });
  });

  it('rejects arbitrary tool execution and verification credentials in scheduled payloads', () => {
    for (const payload of [{ toolName: 'change_password' }, { code: 'secret' }, { mfaCode: '123456' }]) {
      expect(() => scheduledTransferArgs('TRANSFER', { name: 'Recipient', amount: '1.00', ...payload }))
        .toThrow('cannot provide');
    }
  });

  it('does not execute unsupported purchasing flows as a bank payment', () => {
    expect(() => scheduledTransferArgs('PURCHASE', { name: 'Cake store', amount: '100.00' }))
      .toThrow('unsupported');
  });
});
