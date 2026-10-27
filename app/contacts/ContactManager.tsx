'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ContactView } from '@/banking-sdk';
import { Button, EmptyState } from '@/components';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';

interface ContactEnvelope {
  ok: boolean;
  data?: { contact: ContactView };
  error?: { code: string };
}

const inputClass = 'mt-1 w-full rounded-xl border border-banking-navy/20 bg-white px-3 py-2.5 text-sm text-banking-deep outline-hidden focus:border-banking-accent focus:ring-2 focus:ring-banking-accent/10';
const AVATAR_TONES = ['bg-banking-teal-soft text-banking-teal', 'bg-banking-lilac-soft text-banking-lilac',
  'bg-banking-blue-soft text-banking-blue', 'bg-banking-apricot-soft text-banking-apricot'] as const;

export default function ContactManager({ initialContacts }: { initialContacts: ContactView[] }) {
  const { t } = useI18n();
  const [contacts, setContacts] = useState(initialContacts);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: MessageKey; error: boolean } | null>(null);
  const [deleting, setDeleting] = useState<ContactView | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => { setContacts(initialContacts); }, [initialContacts]);
  useEffect(() => {
    if (deleting && !dialog.current?.open) dialog.current?.showModal();
    if (!deleting && dialog.current?.open) dialog.current.close();
  }, [deleting]);

  async function addContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const name = String(fields.get('name') ?? '').trim();
    const phone = String(fields.get('phone') ?? '').trim();
    const bank = String(fields.get('bank') ?? '').trim();
    const remark = String(fields.get('remark') ?? '').trim();
    if (!name || !/^1[3-9]\d{9}$/.test(phone)) {
      setNotice({ key: 'pages.contacts.validation', error: true });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch('/api/contacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, ...(bank ? { bank } : {}), ...(remark ? { remark } : {}) }),
      });
      const result = await response.json() as ContactEnvelope;
      if (!response.ok || !result.ok || !result.data?.contact) {
        setNotice({ key: result.error?.code === 'CONFLICT' ? 'pages.contacts.duplicate' : result.error?.code === 'VALIDATION' ? 'pages.contacts.validation' : 'pages.contacts.failed', error: true });
        return;
      }
      const saved = result.data.contact;
      setContacts(previous => [...previous.filter(contact => contact.id !== saved.id), saved]);
      form.reset();
      setNotice({ key: 'pages.contacts.saved', error: false });
    } catch {
      setNotice({ key: 'pages.contacts.failed', error: true });
    } finally { setBusy(false); }
  }

  async function deleteContact() {
    if (!deleting || busy) return;
    const id = deleting.id;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
      });
      const result = await response.json() as ContactEnvelope;
      // A concurrent deletion has the same visible outcome and must not trap the dialog.
      if ((!response.ok || !result.ok) && result.error?.code !== 'NOT_FOUND') {
        setNotice({ key: 'pages.contacts.deleteFailed', error: true });
        return;
      }
      setContacts(previous => previous.filter(contact => contact.id !== id));
      setDeleting(null);
      setNotice({ key: 'pages.contacts.deleted', error: false });
    } catch {
      setNotice({ key: 'pages.contacts.deleteFailed', error: true });
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="bank-page-heading text-2xl font-semibold text-banking-deep">{t('pages.contacts.title')}</h1>
        <p className="mt-1 text-sm text-banking-navy">{t('pages.contacts.summary', { count: contacts.length })}</p>
      </header>
      {notice ? <p role={notice.error ? 'alert' : 'status'} className={`rounded-xl border p-3 text-sm ${notice.error ? 'border-banking-danger/20 bg-red-50 text-banking-danger' : 'border-banking-success/20 bg-green-50 text-banking-success'}`}>{t(notice.key)}</p> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <section className="grid min-w-0 gap-3 sm:grid-cols-2" data-contact-list>
          {contacts.length === 0 ? <div className="sm:col-span-2"><EmptyState title={t('pages.contacts.emptyTitle')} description={t('pages.contacts.emptyDescription')} /></div> : contacts.map((contact, index) => (
            <article key={contact.id} data-contact-id={contact.id} className="min-w-0 rounded-2xl border border-banking-navy/10 bg-white p-5 shadow-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span data-contact-avatar aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-semibold ${AVATAR_TONES[index % AVATAR_TONES.length]}`}>{Array.from(contact.name)[0]}</span>
                  <div className="min-w-0"><h2 className="break-words font-semibold text-banking-deep">{contact.name}</h2><p className="mt-1 text-sm text-banking-navy/70">{contact.phone}</p></div>
                </div>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setNotice(null); setDeleting(contact); }}>{t('pages.contacts.delete')}</Button>
              </div>
              {contact.bank ? <p className="mt-4 break-words text-sm text-banking-navy">{contact.bank}</p> : null}
              {contact.remark ? <p className="mt-2 break-words text-sm text-banking-navy/60">{contact.remark}</p> : null}
            </article>
          ))}
        </section>
        <form onSubmit={event => void addContact(event)} data-contact-form className="rounded-2xl border border-banking-navy/10 bg-white p-5 shadow-xs">
          <h2 className="mb-4 font-semibold text-banking-deep">{t('pages.contacts.add')}</h2>
          <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
            <label className="block text-sm text-banking-navy">{t('pages.contacts.name')}<input name="name" required maxLength={80} autoComplete="name" className={inputClass} /></label>
            <label className="block text-sm text-banking-navy">{t('pages.contacts.phone')}<input name="phone" type="tel" inputMode="tel" required pattern="1[3-9][0-9]{9}" maxLength={11} autoComplete="tel" className={inputClass} /></label>
            <label className="block text-sm text-banking-navy">{t('pages.contacts.bank')}<input name="bank" maxLength={80} className={inputClass} /></label>
            <label className="block text-sm text-banking-navy">{t('pages.contacts.remark')}<input name="remark" maxLength={200} className={inputClass} /></label>
            <Button type="submit" loading={busy} className="w-full">{t('pages.contacts.save')}</Button>
          </fieldset>
        </form>
      </div>
      <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); else setDeleting(null); }} aria-labelledby="contact-delete-title" data-contact-delete-dialog data-contact-delete-id={deleting?.id} className="m-auto w-[calc(100%_-_2rem)] max-w-md rounded-2xl border border-banking-navy/10 bg-white p-6 text-banking-deep shadow-xl backdrop:bg-banking-deep/40">
        <h2 id="contact-delete-title" className="text-lg font-semibold">{t('pages.contacts.deleteTitle', { name: deleting?.name ?? '' })}</h2>
        <p className="mt-3 text-sm leading-6 text-banking-navy">{t('pages.contacts.deleteDescription')}</p>
        {notice?.error ? <p role="alert" className="mt-3 text-sm text-banking-danger">{t(notice.key)}</p> : null}
        <div className="mt-6 flex justify-end gap-3"><Button variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>{t('app.cancel')}</Button><Button variant="danger" loading={busy} onClick={() => void deleteContact()}>{t('pages.contacts.confirmDelete')}</Button></div>
      </dialog>
    </main>
  );
}
