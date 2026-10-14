import { banking, type ContactView } from '@/banking-sdk';
import { type ContactInput } from '@/banking-sdk/contact';
import { runInTransaction } from '@/banking-sdk/tx';
import { recordAudit } from '@/audit';
import type { RequestIdentity } from './session';

/** Form submission is an explicit confirmation; its audit commits with the saved contact. */
async function mutateContact(
  identity: RequestIdentity,
  operation: 'add_contact' | 'delete_contact',
  mutate: () => Promise<ContactView>,
): Promise<ContactView> {
  return runInTransaction(async client => {
    const contact = await mutate();
    await recordAudit({
      timestamp: Date.now(),
      sessionId: identity.sessionId,
      userId: identity.userId,
      userRequest: operation === 'add_contact' ? 'Save contact from the contact form.' : 'Delete contact from the contact dialog.',
      intent: operation,
      toolName: operation,
      riskLevel: 'YELLOW',
      confirmationRequired: true,
      confirmed: true,
      mfaRequired: false,
      mfaResult: 'not_required',
      toolArgs: { contactId: contact.id, name: contact.name, phone: contact.phone,
        bank: contact.bank, remark: contact.remark },
      toolResult: { ok: true, data: contact },
      status: 'success',
    }, { client, strict: true });
    return contact;
  });
}

export function addSavedContact(identity: RequestIdentity, input: ContactInput): Promise<ContactView> {
  return mutateContact(identity, 'add_contact', () => banking.contact.addContact(identity.userId, input));
}

export function deleteSavedContact(identity: RequestIdentity, id: string): Promise<ContactView> {
  return mutateContact(identity, 'delete_contact', () => banking.contact.removeContact(identity.userId, id));
}
