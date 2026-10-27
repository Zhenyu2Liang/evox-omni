'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardView } from '@/banking-sdk';
import { Button, CardTile, EmptyState } from '@/components';
import { createRequestId } from '@/components/chat/request-id';
import type { AddDemoCardRequest, CardChange, CardChangeResponse } from '@/lib/contracts/card-management';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import CardChangeDialog, { type CardDialogSelection } from './CardChangeDialog';
import CardConsumeDialog from './CardConsumeDialog';
import { cardCanConsume, cardSupportsConsumption, cardUnavailableNoticeKey, linkedAccountNoticeKey } from '@/components/banking/card-account-display';

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string } }
interface Notice { key: MessageKey; error: boolean; attempts?: number }

/** Preserve a proposal's admission ID when a network response is lost. */
export default function CardManager({ initialCards }: { initialCards: CardView[] }) {
  const { t } = useI18n();
  const [cards, setCards] = useState(initialCards);
  const [changes, setChanges] = useState<CardChange[]>([]);
  const [selection, setSelection] = useState<CardDialogSelection | null>(null);
  const [consume, setConsume] = useState<CardView | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const refreshSequence = useRef(0);
  const admission = useRef<{ signature: string; requestId: string } | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const responses = await Promise.all([
        fetch('/api/cards', { cache: 'no-store', signal }),
        fetch('/api/cards/changes', { cache: 'no-store', signal }),
      ]);
      const [cardResult, changeResult] = await Promise.all([
        responses[0].json() as Promise<Envelope<{ cards: CardView[] }>>,
        responses[1].json() as Promise<Envelope<{ changes: CardChange[] }>>,
      ]);
      if (!responses.every(response => response.ok) || !cardResult.ok || !changeResult.ok || !cardResult.data || !changeResult.data) throw new Error('Card refresh failed.');
      if (!mounted.current || signal?.aborted || sequence !== refreshSequence.current) return;
      setCards(cardResult.data.cards);
      setChanges(changeResult.data.changes);
      setLoaded(true);
      setSelection(previous => {
        if (previous?.kind !== 'change') return previous;
        const latest = changeResult.data!.changes.find(change => change.id === previous.change.id);
        return latest ? { kind: 'change', change: latest } : null;
      });
      setConsume(previous => previous ? cardResult.data!.cards.find(card => card.id === previous.id) ?? previous : null);
    } catch {
      if (mounted.current && !signal?.aborted && sequence === refreshSequence.current) {
        setLoaded(false);
        setNotice({ key: 'pages.cards.refreshFailed', error: true });
      }
    } finally {
      if (mounted.current && !signal?.aborted && sequence === refreshSequence.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [refresh]);
  useEffect(() => { setCards(initialCards); }, [initialCards]);

  function open(next: CardDialogSelection) {
    admission.current = null;
    setNotice(null);
    setSelection(next);
  }

  function openConsume(card: CardView) {
    if (!cardSupportsConsumption(card)) {
      setNotice({ key: 'pages.cards.creditConsumeUnsupported', error: true });
      return;
    }
    // A card that is not usable keeps its balances visible, but must never open a spend form.
    if (!cardCanConsume(card)) {
      setNotice({
        key: cardUnavailableNoticeKey(card) ?? linkedAccountNoticeKey(card.linkedAccountStatus) ?? 'pages.cards.consumeUnavailable',
        error: true,
      });
      return;
    }
    setNotice(null);
    setConsume(card);
  }

  async function requestChange(url: string, method: string, body: unknown): Promise<CardChangeResponse | undefined> {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const envelope = await response.json() as Envelope<CardChangeResponse>;
    if (!mounted.current) return;
    if (!response.ok || !envelope.ok || !envelope.data) {
      const code = envelope.error?.code;
      if (code === 'CIRCUIT_OPEN' || code === 'LOCKED') {
        setChanges(previous => previous.map(change => ({ ...change, status: 'locked' })));
        setSelection(previous => previous?.kind === 'change'
          ? { kind: 'change', change: { ...previous.change, status: 'locked' } }
          : previous);
      }
      setNotice({ key: code === 'VALIDATION' ? 'pages.cards.validation' : code === 'CONFLICT' || code === 'NOT_FOUND' ? 'pages.cards.conflict' : code === 'LOCKED' || code === 'CIRCUIT_OPEN' ? 'pages.cards.locked' : 'pages.cards.failed', error: true });
      return;
    }
    return envelope.data;
  }

  async function mutate(work: () => Promise<void>) {
    if (busyRef.current || refreshing || !loaded) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try { await work(); }
    catch { if (mounted.current) setNotice({ key: 'pages.cards.failed', error: true }); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  function proposalId(signature: string): string {
    if (admission.current?.signature !== signature) admission.current = { signature, requestId: createRequestId() };
    return admission.current.requestId;
  }

  async function acceptResult(result: CardChangeResponse) {
    const change = result.change;
    if (change.status === 'executed' || change.status === 'cancelled') {
      setSelection(null);
      admission.current = null;
      setChanges(previous => previous.filter(item => item.id !== change.id));
      if (change.status === 'executed' && change.card) {
        const card = change.card;
        setCards(previous => change.kind === 'add' ? [...previous.filter(item => item.id !== card.id), card] : previous.filter(item => item.id !== card.id));
      }
      setNotice({ key: change.status === 'cancelled' ? 'pages.cards.cancelled' : change.kind === 'add' ? 'pages.cards.added' : 'pages.cards.deleted', error: false });
      await refresh();
      return;
    }
    setChanges(previous => [...previous.filter(item => item.id !== change.id), change]);
    setSelection({ kind: 'change', change });
    if (change.status === 'locked' || result.locked) setNotice({ key: 'pages.cards.locked', error: true });
    else if (result.ok === false) setNotice({ key: 'pages.cards.verificationFailed', error: true, attempts: result.attemptsLeft ?? 0 });
  }

  function prepareAdd(input: Omit<AddDemoCardRequest, 'requestId'>) {
    void mutate(async () => {
      const result = await requestChange('/api/cards', 'POST', {
        ...input, requestId: proposalId(JSON.stringify(input)),
      });
      if (result) await acceptResult(result);
    });
  }

  function prepareDelete(card: CardView) {
    void mutate(async () => {
      const result = await requestChange(`/api/cards/${encodeURIComponent(card.id)}`, 'DELETE', {
        requestId: proposalId(card.id),
      });
      if (result) await acceptResult(result);
    });
  }

  function verifyChange(change: CardChange, code: string) {
    void mutate(async () => {
      const result = await requestChange(`/api/cards/changes/${encodeURIComponent(change.id)}/verify`, 'POST', { code });
      if (result) await acceptResult(result);
    });
  }

  function cancelChange(change: CardChange) {
    void mutate(async () => {
      const result = await requestChange(`/api/cards/changes/${encodeURIComponent(change.id)}/cancel`, 'POST', {});
      if (result) await acceptResult(result);
    });
  }

  const disabled = busy || refreshing || !loaded;
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="bank-page-heading text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.cards.title')}</h1><p className="mt-1 text-sm text-banking-navy">{t('pages.cards.summary', { count: cards.length })}</p></div>
        <div className="flex flex-wrap gap-2"><span data-card-refresh><Button variant="secondary" loading={refreshing} disabled={busy} onClick={() => { setNotice(null); void refresh(); }}>{t('pages.cards.refresh')}</Button></span><span data-card-add><Button disabled={disabled} onClick={() => open({ kind: 'add' })}>{t('pages.cards.add')}</Button></span></div>
      </header>
      <p className="rounded-xl bg-banking-light p-4 text-sm leading-6 text-banking-navy">{t('pages.cards.demoDescription')}</p>
      {notice ? <p role={notice.error ? 'alert' : 'status'} className={`rounded-xl border p-3 text-sm ${notice.error ? 'border-banking-danger/20 bg-red-50 text-banking-danger' : 'border-banking-success/20 bg-green-50 text-banking-success'}`}>{t(notice.key, notice.attempts === undefined ? {} : { attempts: notice.attempts })}</p> : null}
      {changes.length ? <section data-card-pending-changes className="rounded-2xl border border-banking-navy/10 bg-white p-5"><h2 className="font-semibold text-banking-deep">{t('pages.cards.pending')}</h2><ul className="mt-3 space-y-3">{changes.map(change => <li key={change.id} data-card-pending-change-id={change.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-banking-light pt-3"><div className="text-sm text-banking-navy">{t(change.kind === 'add' ? 'pages.cards.reviewAdd' : 'pages.cards.reviewDelete')}{change.card ? <span className="ml-2 font-mono">{change.card.numberMasked}</span> : null}{change.status === 'locked' ? <p className="mt-1 text-banking-danger">{t('pages.cards.locked')}</p> : null}</div><Button variant="secondary" disabled={disabled} onClick={() => open({ kind: 'change', change })}>{t('pages.cards.resume')}</Button></li>)}</ul></section> : null}
      {cards.length ? <section data-card-list className="grid min-w-0 gap-4 sm:grid-cols-2">{cards.map(card => <div key={card.id} data-card-id={card.id}><CardTile card={card} footer={<div className="flex flex-wrap items-center justify-end gap-2 [&_button]:whitespace-nowrap">{cardSupportsConsumption(card) ? <span data-card-consume><Button variant="secondary" size="sm" disabled={disabled || !cardCanConsume(card)} onClick={() => openConsume(card)}>{t('pages.cards.consume')}</Button></span> : <span data-card-consume-unavailable className="basis-full self-center text-right text-xs text-banking-navy/70 sm:basis-auto">{t('pages.cards.creditConsumeUnsupported')}</span>}<span data-card-delete><Button variant="ghost" size="sm" disabled={disabled || changes.some(change => change.kind === 'delete' && change.card?.id === card.id)} onClick={() => open({ kind: 'delete', card })}>{t('pages.cards.delete')}</Button></span></div>} /></div>)}</section> : <EmptyState title={t('pages.cards.emptyTitle')} description={t('pages.cards.emptyDescription')} />}
      {selection ? <CardChangeDialog
        key={selection.kind === 'change' ? selection.change.id : selection.kind === 'delete' ? selection.card.id : 'add'}
        selection={selection}
        busy={busy}
        error={notice?.error ? t(notice.key, notice.attempts === undefined ? {} : { attempts: notice.attempts }) : undefined}
        onClose={() => { if (!busyRef.current) setSelection(null); }}
        onPrepareAdd={prepareAdd}
        onPrepareDelete={prepareDelete}
        onVerify={verifyChange}
        onCancel={cancelChange}
      /> : null}
      {consume ? <CardConsumeDialog key={consume.id} card={consume} onClose={() => setConsume(null)} onConsumed={() => { void refresh(); }} /> : null}
    </main>
  );
}
