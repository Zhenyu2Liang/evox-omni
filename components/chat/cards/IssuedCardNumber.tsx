'use client';

import { useEffect, useState } from 'react';
import { Button } from '../../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';

/** Only the browser receipt reads the verified number; it is not part of chat/model history. */
export function IssuedCardNumber({ actionId, cardId }: { actionId: string; cardId: string }) {
  const { t } = useI18n();
  const [number, setNumber] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!revealed) return;
    const controller = new AbortController();
    setNumber(undefined); setFailed(false); setCopied(false);
    void (async () => {
      try {
        const response = await fetch(`/api/actions/${encodeURIComponent(actionId)}/card-number`, { cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (!response.ok || !body.ok || body.data.cardId !== cardId || !/^\d{12,19}$/.test(body.data.cardNumber)) throw new Error('Issuance number unavailable');
        if (!controller.signal.aborted) setNumber(body.data.cardNumber);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => controller.abort();
  }, [actionId, cardId, attempt, revealed]);

  async function copy() {
    if (!number) return;
    try { await navigator.clipboard.writeText(number); setCopied(true); }
    catch { setCopied(false); }
  }

  return <section data-issued-card-number data-issued-card-id={cardId} className="space-y-2 rounded-xl bg-banking-neutral p-3">
    <p className="text-sm font-semibold text-banking-deep">{t('business.cards.issuedNumber')}</p>
    {!revealed ? <Button size="sm" onClick={() => setRevealed(true)}>{t('business.presentation.showNumber')}</Button> : number ? <>
      <p data-full-card-number className="break-all font-mono text-lg tracking-wider text-banking-deep">{number}</p>
      <Button size="sm" onClick={() => void copy()}>{t(copied ? 'business.cards.numberCopied' : 'business.cards.copyNumber')}</Button>
      <Button size="sm" variant="secondary" onClick={() => { setRevealed(false); setNumber(undefined); setCopied(false); }}>{t('business.presentation.hideNumber')}</Button>
      <p className="text-xs text-banking-navy">{t('business.cards.issuedNumberHint')}</p>
    </> : failed ? <>
      <p role="status" className="text-sm text-banking-navy">{t('business.cards.numberUnavailable')}</p>
      <Button size="sm" onClick={() => setAttempt(value => value + 1)}>{t('business.cards.retryNumber')}</Button>
    </> : <p role="status" className="text-sm text-banking-navy">{t('business.cards.numberLoading')}</p>}
  </section>;
}
