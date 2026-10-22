'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CardConsumptionView, CardView, ConsumeCardResult } from '@/banking-sdk';
import { Button, CardTile, Money } from '@/components';
import { createRequestId } from '@/components/chat/request-id';
import { formatDateTime } from '@/lib/date';
import { moneyToCents, normalizeMoney } from '@/lib/money';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message?: string } }
interface Notice { key: MessageKey; error: boolean; detail?: string }

const AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const inputClass = 'mt-1 w-full rounded-xl border border-banking-navy/20 bg-white px-3 py-2.5 text-sm outline-hidden focus:border-banking-accent focus:ring-2 focus:ring-banking-accent/10';

/** Map a spend failure code to its localized message key. */
function failureKey(code: string | undefined): MessageKey {
  if (code === 'INSUFFICIENT_FUNDS') return 'pages.cards.consumeInsufficient';
  if (code === 'LIMIT_EXCEEDED') return 'pages.cards.consumeLimitExceeded';
  if (code === 'CONFLICT') return 'pages.cards.consumeUnavailable';
  return 'pages.cards.consumeFailed';
}

/**
 * Per-card simulated spend: a native modal that shows the card's spending headroom and its existing
 * consumption records, then charges the bound account through `POST /api/cards/[id]/consume`.
 *
 * A card that cannot spend (`usable === false`, or a `MISSING`/`UNTRUSTED` settlement account) still
 * renders the projection's balances — unavailable is not the same as empty — but submits nothing.
 *
 * A retry of the same spend attempt reuses its `executionKey`, so a lost response replays the same
 * persisted consumption instead of charging twice; a fresh (successful) spend gets a new key. The
 * body carries no booking time: `occurredAt` is SERVER-owned (the server business clock), so a
 * client can never choose which month a spend lands in, and a body naming it is refused.
 */
export default function CardConsumeDialog({ card, onClose, onConsumed }: {
  card: CardView;
  onClose: () => void;
  onConsumed: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const attempt = useRef<{ signature: string; executionKey: string } | null>(null);
  const [consumptions, setConsumptions] = useState<CardConsumptionView[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validationFailed, setValidationFailed] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);

  const loadConsumptions = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/consumptions`, { cache: 'no-store', signal });
      const envelope = await response.json() as Envelope<{ consumptions: CardConsumptionView[] }>;
      if (!response.ok || !envelope.ok || !envelope.data) throw new Error('Consumption load failed.');
      if (!mounted.current || signal?.aborted) return;
      setConsumptions(envelope.data.consumptions);
      setRecordsLoaded(true);
    } catch {
      if (mounted.current && !signal?.aborted) {
        setRecordsLoaded(false);
        setNotice({ key: 'pages.cards.failed', error: true });
      }
    }
  }, [card.id]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadConsumptions(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [loadConsumptions]);

  /** Reuse the original execution identity when the user retries the same spend attempt. */
  function executionKey(signature: string): string {
    if (attempt.current?.signature !== signature) attempt.current = { signature, executionKey: createRequestId() };
    return attempt.current.executionKey;
  }

  async function consume(input: { amount: string; category: string; merchant: string }) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const signature = JSON.stringify({ cardId: card.id, ...input });
      const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: input.amount,
          ...(input.category ? { category: input.category } : {}),
          ...(input.merchant ? { merchant: input.merchant } : {}),
          executionKey: executionKey(signature),
        }),
      });
      const envelope = await response.json() as Envelope<ConsumeCardResult>;
      if (!mounted.current) return;
      if (!response.ok || !envelope.ok || !envelope.data) {
        const code = envelope.error?.code;
        const detail = envelope.error?.message;
        // `VALIDATION` also covers a body naming a server-owned field (the booking time), so show
        // the server's own reason instead of folding every refusal into a generic failure.
        setNotice(code === 'VALIDATION' && detail ? { key: failureKey(code), error: true, detail } : { key: failureKey(code), error: true });
        return;
      }
      attempt.current = null;
      setNotice({ key: 'pages.cards.consumeSuccess', error: false });
      onConsumed();
      await loadConsumptions();
    } catch {
      if (mounted.current) setNotice({ key: 'pages.cards.consumeFailed', error: true });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || blocked) return;
    const fields = new FormData(event.currentTarget);
    const amountText = String(fields.get('amount') ?? '').trim();
    const category = String(fields.get('category') ?? '').trim();
    const merchant = String(fields.get('merchant') ?? '').trim();
    try {
      if (!AMOUNT_PATTERN.test(amountText) || moneyToCents(amountText) <= 0n) throw new Error('Invalid amount.');
    } catch {
      setValidationFailed(true);
      return;
    }
    setValidationFailed(false);
    void consume({ amount: normalizeMoney(amountText), category, merchant });
  }

  const linked = card.linkedAccountStatus === 'LINKED';
  const blocked = !card.usable || card.linkedAccountStatus === 'MISSING' || card.linkedAccountStatus === 'UNTRUSTED';
  // Read every value straight from the projection: an absent balance is never rendered as 0.
  const linkedName = card.linkedAccountName?.trim() ? card.linkedAccountName : undefined;
  const hasSummary = linked || card.monthlyLimit !== undefined;

  /** Why this card cannot spend right now, in display order. */
  const unavailable: MessageKey[] = [];
  if (!card.usable) unavailable.push(card.status === 'FROZEN' ? 'business.cards.cardFrozenNotice' : card.status === 'LOST' ? 'business.cards.cardLostNotice' : 'business.cards.cardUnavailable');
  if (card.linkedAccountStatus === 'MISSING') unavailable.push('business.cards.linkedAccountMissing');
  if (card.linkedAccountStatus === 'UNTRUSTED') unavailable.push('business.cards.linkedAccountUntrusted');

  return (
    <dialog ref={dialog} data-card-consume-dialog data-card-consume-card-id={card.id} aria-labelledby="card-consume-title" onCancel={event => {
      event.preventDefault();
      if (!busyRef.current) onClose();
    }} className="m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-banking-navy/10 bg-white p-5 text-banking-deep shadow-xl backdrop:bg-banking-deep/40 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 id="card-consume-title" className="text-lg font-semibold">{t('pages.cards.consumeTitle')}</h2>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t('pages.cards.close')}</Button>
      </div>

      <div className="mt-4"><CardTile card={card} /></div>

      {unavailable.length ? <div role="status" className="mt-3 space-y-1 rounded-xl border border-banking-danger/20 bg-red-50 p-3 text-sm text-banking-danger">{unavailable.map(key => <p key={key}>{t(key)}</p>)}</div> : null}

      {hasSummary ? <dl data-card-consume-summary className="mt-3 space-y-2 rounded-xl bg-banking-light/60 p-4 text-sm">
        {linked && (linkedName !== undefined || card.linkedAccountNumber !== undefined) ? <div className="flex justify-between gap-3"><dt>{t('business.cards.linkedAccount')}</dt><dd className="flex min-w-0 items-baseline justify-end gap-2 text-right">{linkedName !== undefined ? <span className="font-semibold text-banking-deep">{linkedName}</span> : null}{card.linkedAccountNumber !== undefined ? <span className="font-mono">{card.linkedAccountNumber}</span> : null}</dd></div> : null}
        {linked && card.accountAvailableBalance !== undefined ? <div className="flex justify-between gap-3"><dt>{t('business.cards.accountBalance')}</dt><dd><Money amount={card.accountAvailableBalance} /></dd></div> : null}
        {linked && card.payableAmount !== undefined ? <div className="flex justify-between gap-3"><dt>{t('business.cards.usableBalance')}</dt><dd><Money amount={card.payableAmount} /></dd></div> : null}
        {card.monthlyLimit !== undefined ? <div className="flex justify-between gap-3"><dt>{t('business.cards.monthlyLimit')}</dt><dd><Money amount={card.monthlyLimit} /></dd></div> : null}
      </dl> : null}

      {validationFailed || notice ? <p role={validationFailed || notice?.error ? 'alert' : 'status'} className={`mt-3 rounded-xl border p-3 text-sm ${validationFailed || notice?.error ? 'border-banking-danger/20 bg-red-50 text-banking-danger' : 'border-banking-success/20 bg-green-50 text-banking-success'}`}>{validationFailed ? t('pages.cards.validation') : notice!.detail ?? t(notice!.key)}</p> : null}

      <section data-card-consumptions className="mt-4">
        <h3 className="font-semibold text-banking-deep">{t('pages.cards.consumptions')}</h3>
        {recordsLoaded ? (consumptions.length === 0 ? <p data-card-consumptions-empty className="mt-2 text-sm text-banking-navy/70">{t('pages.cards.consumptionsEmpty')}</p> : <ul className="mt-2 space-y-2">{consumptions.map(record => <li key={record.id} data-card-consumption={record.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-banking-light pt-2 text-sm"><div className="min-w-0"><div className="truncate text-banking-deep">{record.merchant}</div><div className="text-xs text-banking-navy/60">{formatDateTime(record.occurredAt)} · {record.category}</div></div><Money amount={record.amount} /></li>)}</ul>) : null}
      </section>

      <form onSubmit={submit} data-card-consume-form className="mt-5">
        <fieldset disabled={busy || blocked} className="space-y-4 disabled:opacity-60">
          <label className="block text-sm">{t('pages.cards.consumeAmount')}<input name="amount" type="text" inputMode="decimal" required maxLength={24} className={inputClass} /></label>
          <label className="block text-sm">{t('pages.cards.consumeCategory')}<input name="category" type="text" maxLength={32} className={inputClass} /></label>
          <label className="block text-sm">{t('pages.cards.consumeMerchant')}<input name="merchant" type="text" maxLength={64} className={inputClass} /></label>
          <Button type="submit" loading={busy} disabled={blocked} className="w-full">{t('pages.cards.consumeSubmit')}</Button>
        </fieldset>
      </form>
    </dialog>
  );
}
