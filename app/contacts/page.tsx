import { banking } from '@/banking-sdk';
import { getConfig } from '@/lib/config';
import ContactManager from './ContactManager';

export const dynamic = 'force-dynamic';

export default async function ContactsPage() {
  return <ContactManager initialContacts={await banking.contact.listContacts(getConfig().demoUserId)} />;
}
