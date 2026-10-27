'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CardType, CardView } from '@/banking-sdk';
import { Button, Money, StatusBadge } from '@/components';
import type { AddDemoCardRequest, CardChange } from '@/lib/contracts/card-management';
import { moneyToCents, normalizeMoney } from '@/lib/money';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';

export type CardDialogSelection = { kind: 'add' } | { kind: 'delete'; card: CardView } | { kind: 'change'; change: CardChange };

interface CardChangeDialogProps {
  selection: CardDialogSelection;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onPrepareAdd: (input: Omit<AddDemoCardRequest, 'requestId'>) => void;
  onPrepareDelete: (card: CardView) => void;
  onVerify: (change: CardChange, code: string) => void;
  onCancel: (change: CardChange) => void;
}

const typeLabels: Record<CardType, MessageKey> = {
  DEBIT: 'business.cards.debit', CREDIT: 'business.cards.credit', VIRTUAL: 'business.cards.virtual',
};
const inputClass = 'mt-1 w-full rounded-xl border border-banking-navy/20 bg-banking-surface px-3 py-2.5 text-sm outline-hidden focus:border-banking-accent focus:ring-2 focus:ring-banking-accent/10';

/** A native modal keeps focus inside the reviewed operation and supports keyboard cancellation. */
export default function CardChangeDialog(props: CardChangeDialogProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [type, setType] = useState<CardType>('DEBIT');
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [validationFailed, setValidationFailed] = useState(false);
  const { selection, busy } = props;
  const change = selection.kind === 'change' ? selection.change : undefined;
  const deleting = selection.kind === 'delete' || change?.kind === 'delete';
  const card = selection.kind === 'delete' ? selection.card : change?.card;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);

  function prepareAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const credit = type === 'CREDIT' ? String(fields.get('creditLimit') ?? '').trim() : '';
    const monthly = String(fields.get('monthlyLimit') ?? '').trim();
    try {
      for (const amount of [credit, monthly].filter(Boolean)) {
        if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || moneyToCents(amount) < 0n) throw new Error('Invalid amount.');
      }
      if (type === 'CREDIT' && (!credit || moneyToCents(credit) <= 0n)) throw new Error('Invalid credit limit.');
      setValidationFailed(false);
      props.onPrepareAdd({ type, ...(credit ? { creditLimit: normalizeMoney(credit) } : {}), ...(monthly ? { monthlyLimit: normalizeMoney(monthly) } : {}) });
    } catch { setValidationFailed(true); }
  }

  function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (change?.status === 'pending' && confirmed && /^\d{6}$/.test(code.trim()) && !busy) props.onVerify(change, code.trim());
  }

  return (
    <dialog ref={dialog} data-card-change-dialog data-card-change-id={change?.id} data-card-change-status={change?.status} aria-labelledby="card-change-title" onCancel={event => {
      event.preventDefault();
      if (!busy) props.onClose();
    }} className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-banking-navy/10 bg-banking-surface p-5 text-banking-deep shadow-xl backdrop:bg-banking-ink/40 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 id="card-change-title" className="text-lg font-semibold">{t(deleting ? 'pages.cards.reviewDelete' : change ? 'pages.cards.reviewAdd' : 'pages.cards.add')}</h2>
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onClose}>{t('pages.cards.close')}</Button>
      </div>
      <p className="mt-3 text-sm leading-6 text-banking-navy">{t(deleting ? 'pages.cards.deleteDescription' : 'pages.cards.addDescription')}</p>
      {props.error || validationFailed ? <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-banking-danger">{validationFailed ? t('pages.cards.validation') : props.error}</p> : null}

      {selection.kind === 'add' ? <form onSubmit={prepareAdd} data-card-add-form className="mt-5">
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
          <label className="block text-sm">{t('pages.cards.type')}<select name="type" value={type} onChange={event => setType(event.target.value as CardType)} className={inputClass}>{(Object.keys(typeLabels) as CardType[]).map(value => <option key={value} value={value}>{t(typeLabels[value])}</option>)}</select></label>
          {type === 'CREDIT' ? <label className="block text-sm">{t('pages.cards.creditLimit')}<input name="creditLimit" type="text" inputMode="decimal" required maxLength={24} className={inputClass} /></label> : null}
          <label className="block text-sm">{t('pages.cards.monthlyLimit')}<input name="monthlyLimit" type="text" inputMode="decimal" maxLength={24} className={inputClass} /></label>
          <Button type="submit" loading={busy} className="w-full">{t('pages.cards.review')}</Button>
        </fieldset>
      </form> : <div className="mt-5">
        <dl className="space-y-3 rounded-xl bg-banking-light/60 p-4 text-sm">
          <div className="flex justify-between gap-3"><dt>{t('pages.cards.type')}</dt><dd>{t(typeLabels[card?.type ?? change?.type ?? 'DEBIT'])}</dd></div>
          {card ? <div className="font-mono text-lg tracking-widest">{card.numberMasked}</div> : null}
          {(change?.creditLimit ?? card?.creditLimit) !== undefined ? <div className="flex justify-between gap-3"><dt>{t('business.cards.limit')}</dt><dd><Money amount={(change?.creditLimit ?? card?.creditLimit)!} /></dd></div> : null}
          {(change?.monthlyLimit ?? card?.monthlyLimit) !== undefined ? <div className="flex justify-between gap-3"><dt>{t('business.cards.monthlyLimit')}</dt><dd><Money amount={(change?.monthlyLimit ?? card?.monthlyLimit)!} /></dd></div> : null}
        </dl>
        {!change && selection.kind === 'delete' ? <div className="mt-5 flex justify-end"><Button variant="danger" loading={busy} onClick={() => props.onPrepareDelete(selection.card)}>{t('pages.cards.review')}</Button></div> : null}
        {change ? <>
          <div className="mt-4"><StatusBadge tier="RED" /></div>
          {change.status === 'locked' ? <p role="status" className="mt-3 text-sm text-banking-danger">{t('pages.cards.locked')}</p> : null}
          <form onSubmit={verify} data-card-verification-form className="mt-4 space-y-4">
            <fieldset disabled={busy || change.status !== 'pending'} className="space-y-4 disabled:opacity-60">
              <label className="flex items-start gap-3 text-sm"><input name="confirmed" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-banking-accent" />{t('pages.cards.confirmDetails')}</label>
              <label className="block text-sm">{t('cards.mfa.label')}<input name="code" value={code} onChange={event => setCode(event.target.value)} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} className={inputClass} /></label>
              <p className="text-xs leading-5 text-banking-navy">{t('pages.cards.verificationHint')}</p>
            </fieldset>
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="secondary" disabled={busy} onClick={() => props.onCancel(change)}>{t('pages.cards.cancelChange')}</Button>
              <Button type="submit" variant={deleting ? 'danger' : 'primary'} loading={busy} disabled={!confirmed || !/^\d{6}$/.test(code.trim()) || change.status !== 'pending'}>{t('pages.cards.verify')}</Button>
            </div>
          </form>
        </> : null}
      </div>}
    </dialog>
  );
}
