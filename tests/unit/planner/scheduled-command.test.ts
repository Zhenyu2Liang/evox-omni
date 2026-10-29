import { describe, expect, it } from 'vitest';
import { scheduledTransferArgs, validateScheduledPayload } from '@/lib/contracts/scheduled-command';
import { validateBankingParameters } from '@/agent/tools/plan-parameters';

describe('scheduled payment compilation', () => {
  it('rejects mixed selectors and display-only fields at the model schema boundary', () => {
    const outer = { name: 'Transfer', kind: 'TRANSFER', runAtLocal: '2026-10-30T10:00' };
    for (const payload of [
      { contactId: 'contact_mama', amount: '300.00', phone: '136****0004', recipientName: '妈妈' },
      { phone: '136****0004', amount: '300.00' },
      { contactId: 'contact_mama', name: '妈妈', amount: '300.00' },
    ]) expect(() => validateBankingParameters('create_scheduled_task', { ...outer, payload }, 'call')).toThrow();
    expect(() => validateBankingParameters('create_scheduled_task', { ...outer, payload: { contactId: 'contact_mama', amount: '300.00' } }, 'call')).not.toThrow();
    expect(() => validateBankingParameters('create_scheduled_task', { ...outer, kind: 'REMINDER', payload: { note: 'Reminder' } }, 'call')).not.toThrow();
  });
  it('preserves exact decimal text and explicitly provided recipient selectors', () => {
    expect(scheduledTransferArgs('TRANSFER', { contactId: 'contact', amount: '90071992547409.01' }))
      .toEqual({ contactId: 'contact', amount: '90071992547409.01' });
  });

  it('requires the current recipient field for a scheduled payment', () => {
    expect(() => scheduledTransferArgs('PAYMENT', { toName: 'Landlord', amount: '200.00' }))
      .toThrow('unsupported fields');
    expect(scheduledTransferArgs('PAYMENT', { name: 'Landlord', amount: '200.00' }))
      .toEqual({ name: 'Landlord', amount: '200.00' });
  });

  it('rejects arbitrary tool execution and verification credentials in scheduled payloads', () => {
    for (const payload of [{ toolName: 'unsupported_secret_tool' }, { code: 'secret' }, { mfaCode: '123456' }]) {
      expect(() => scheduledTransferArgs('TRANSFER', { name: 'Recipient', amount: '1.00', ...payload }))
        .toThrow('unsupported fields');
    }
  });

  it('does not execute unsupported purchasing flows as a bank payment', () => {
    expect(() => scheduledTransferArgs('PURCHASE', { name: 'Cake store', amount: '100.00' }))
      .toThrow('unsupported');
  });

  it('rejects multiple selectors, numeric money and invalid optional account types', () => {
    for (const payload of [
      { contactId: 'contact', name: 'Recipient', amount: '1.00' },
      { contactId: 'contact', amount: 1 },
      { contactId: 'contact', amount: '1.00', sourceAccountId: 42 },
      { contactId: 'contact', amount: '-10.00' },
    ]) expect(() => scheduledTransferArgs('TRANSFER', payload)).toThrow();
  });

  it('keeps reminder payloads inert and rejects command fields', () => {
    expect(validateScheduledPayload('REMINDER', { note: 'Pay the bill' })).toEqual({ note: 'Pay the bill' });
    expect(validateScheduledPayload('REMINDER', undefined)).toBeUndefined();
    expect(() => validateScheduledPayload('REMINDER', { toolName: 'transfer_money' })).toThrow();
  });
});
