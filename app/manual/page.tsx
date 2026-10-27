'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ManualResolution, ManualReviewInbox, ManualReviewRecord, ManualReviewTarget } from '@/lib/contracts/manual-review';
import { Badge, Button, Card } from '@/components/ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { isMessageKey, type MessageKey } from '@/lib/i18n/shared';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok) throw new Error(envelope.error?.message ?? 'tasks.manual.requestFailed');
  return envelope.data as T;
}

function ReviewForm({ title, handoff = false, onSubmit, busy, mayRetry, mayResume, mayStop = true }: {
  title: string; handoff?: boolean; busy: boolean; mayRetry?: boolean; mayResume?: boolean; mayStop?: boolean;
  onSubmit: (text: string, resolution: ManualResolution) => Promise<void>;
}) {
  const { t } = useI18n();
  const label = t(handoff ? 'tasks.manual.reasonLabel' : 'tasks.manual.notesLabel');
  const [text, setText] = useState('');
  return <div className="space-y-3">
    <label className="block text-sm font-medium">{label}
      <textarea aria-label={t('tasks.manual.formLabel', { label, title })} value={text} onChange={(e) => setText(e.target.value)}
        maxLength={handoff ? 1000 : 2000} rows={3}
        className="mt-2 w-full rounded-xl border border-gray-300 p-3 font-normal" placeholder={t('tasks.manual.placeholder')} />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button loading={busy} disabled={!mayStop || text.trim().length < 5} onClick={() => void onSubmit(text, 'stop')}>
        {t(handoff ? 'tasks.manual.handoff' : 'tasks.manual.stop')}
      </Button>
      {mayRetry && <Button variant="secondary" disabled={busy || text.trim().length < 5}
        onClick={() => void onSubmit(text, 'retry')}>{t('tasks.manual.saveAndRetry')}</Button>}
      {mayResume && <Button variant="secondary" disabled={busy || text.trim().length < 5}
        onClick={() => void onSubmit(text, 'resume')}>{t('tasks.manual.saveAndResume')}</Button>}
    </div>
  </div>;
}

export default function ManualPage() {
  const { t } = useI18n();
  const { enabled, pending, setEnabled } = useDeveloperMode();
  if (enabled) return <ManualReviewInboxPage />;
  return <main className="mx-auto w-full min-w-0 max-w-6xl p-4 sm:p-6 lg:p-8">
    <section className="rounded-2xl border border-banking-border bg-white p-6">
      <h1 className="text-xl font-semibold text-banking-deep">{t('tasks.manual.title')}</h1>
      <p className="mt-3 text-sm text-banking-navy">{t('tasks.manual.developerRequired')}</p>
      <button type="button" disabled={pending} onClick={() => setEnabled(true)} className="mt-5 min-h-11 rounded-xl bg-banking-accent px-4 text-sm font-semibold text-white disabled:opacity-60">{t('app.enableDeveloperMode')}</button>
    </section>
  </main>;
}

function ManualReviewInboxPage() {
  const { t, locale } = useI18n();
  const [inbox, setInbox] = useState<ManualReviewInbox>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<MessageKey | ''>('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setInbox(await request<ManualReviewInbox>('/api/manual-reviews')), []);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, [load]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : 'tasks.manual.actionFailed'); }
    finally { await load().catch(() => {}); setBusy(false); }
  }

  async function continueTask(review: ManualReviewRecord) {
    if (!review.taskId) return;
    if (review.resolution === 'resume' && review.workflowStatus === 'waiting_confirmation') {
      setNotice('tasks.manual.controlReleased');
      return;
    }
    const plan = await request<{ status: string }>(`/api/tasks/${review.taskId}`, { action: review.resolution === 'resume' ? 'resume' : 'retry' });
    setNotice(plan.status === 'waiting_confirmation' ? 'tasks.manual.confirmationNeeded'
      : plan.status === 'success' ? 'tasks.manual.completed' : 'tasks.manual.updated');
  }

  function open(target: ManualReviewTarget, reason: string) {
    return act(async () => {
      await request('/api/manual-reviews', { taskId: target.taskId, actionId: target.actionId, reason });
      setNotice('tasks.manual.handoffRequested');
    });
  }

  function resolve(review: ManualReviewRecord, notes: string, resolution: ManualResolution) {
    return act(async () => {
      const saved = await request<ManualReviewRecord>(`/api/manual-reviews/${review.id}`, { resolution, notes });
      if (resolution === 'retry' || resolution === 'resume') await continueTask(saved);
      else setNotice('tasks.manual.stopped');
    });
  }

  return <main className="mx-auto w-full min-w-0 max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
    <header>
      <h1 className="text-2xl font-semibold tracking-tight text-banking-deep">{t('tasks.manual.title')}</h1>
      <p className="mt-1 text-sm text-banking-navy">{t('tasks.manual.description', { operator: inbox?.operatorName ?? t('tasks.manual.checkingSession') })}</p>
    </header>
    <div className="flex flex-wrap gap-4 text-sm"><Link href="/agent" className="text-banking-interactive underline">{t('tasks.manual.returnToAssistant')}</Link>
      <Link href="/audit" className="text-banking-interactive underline">{t('tasks.manual.viewAudit')}</Link>
      <Button variant="ghost" disabled={busy} onClick={() => void act(async () => { await load(); })}>{t('tasks.approvals.refresh')}</Button></div>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{isMessageKey(error) ? t(error) : error}</p>}
    {notice && <p role="status" className="rounded-xl bg-banking-neutral p-3 text-banking-interactive">{t(notice)}</p>}
    {!inbox && !error && <p>{t('tasks.approvals.loading')}</p>}
    {inbox && inbox.candidates.length === 0 && inbox.reviews.length === 0 && <p>{t('tasks.manual.empty')}</p>}
    {inbox?.reviews.map((review) => <section key={review.id} data-review-id={review.id}>
      <Card title={review.title} description={t('tasks.manual.reviewDescription', { operator: review.operatorName, time: new Date(review.createdAt).toLocaleString(locale) })}>
        <div className="space-y-3">
          <Badge tone={review.status === 'open' ? 'warn' : 'neutral'}>{t(review.status === 'open' ? 'tasks.manual.open' : 'tasks.manual.resolved')}</Badge>
          <p className="text-sm">{t('tasks.manual.reason', { reason: review.reason })}</p>
          {review.handoffStatus === 'human_review_requested' && <p role="status" className="text-sm text-banking-navy">
            {t('tasks.manual.waitingCheckpoint')}
          </p>}
          {review.status === 'open' ? <ReviewForm title={review.title} busy={busy} mayRetry={review.mayRetry}
            mayResume={review.mayResume} mayStop={review.mayStop}
            onSubmit={(text, resolution) => resolve(review, text, resolution)} /> : <>
            <p className="text-sm">{t('tasks.manual.notes', { notes: review.notes ?? '' })}</p>
            <p className="text-xs text-gray-500">{t('tasks.manual.resolvedAt', { time: review.resolvedAt ? new Date(review.resolvedAt).toLocaleString(locale) : '' })}</p>
            <p className="text-sm">{t(review.resolution === 'retry' ? 'tasks.manual.retryResolution'
              : review.resolution === 'resume' ? 'tasks.manual.resumeResolution' : 'tasks.manual.stopResolution')}</p>
            {review.resolution === 'retry' && review.mayRetry && <Button disabled={busy} variant="secondary"
              onClick={() => void act(() => continueTask(review))}>{t('tasks.manual.continueWithConfirmation')}</Button>}
            {review.resolution === 'resume' && review.mayResume && <Button disabled={busy} variant="secondary"
              onClick={() => void act(() => continueTask(review))}>{t('tasks.manual.continueOriginal')}</Button>}
          </>}
        </div>
      </Card>
    </section>)}
    {inbox?.candidates.map((target) => <section key={target.taskId ?? target.actionId}>
      <Card title={target.title} description={target.error}>
        <ReviewForm title={target.title} handoff busy={busy} onSubmit={(text) => open(target, text)} />
      </Card>
    </section>)}
  </main>;
}
