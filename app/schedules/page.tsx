'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ScheduleInbox } from '@/lib/contracts/schedule';
import { Badge, Button, Card, EmptyState } from '@/components/ui';
import { formatDateTime } from '@/lib/date';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { isMessageKey } from '@/lib/i18n/shared';

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const envelope = await response.json();
  if (!response.ok || envelope.ok !== true) throw new Error(envelope.error?.message ?? 'tasks.schedules.requestFailed');
  return envelope.data as T;
}

export default function SchedulesPage() {
  const { t } = useI18n();
  const label = (key: string, fallback: string) => isMessageKey(key) ? t(key) : fallback;
  const [inbox, setInbox] = useState<ScheduleInbox>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => setInbox(await request<ScheduleInbox>('/api/schedules')), []);
  useEffect(() => { void load().catch(issue => setError(issue instanceof Error ? issue.message : 'tasks.schedules.loadFailed')); }, [load]);

  async function tick() {
    setBusy(true); setError('');
    try { await request('/api/schedules/tick', {}); await load(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'tasks.schedules.dispatchFailed'); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto w-full min-w-0 max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight text-banking-deep">{t('tasks.schedules.title')}</h1>
      <p className="text-sm text-banking-navy">{t('tasks.schedules.description')}</p>
      <div className="flex flex-wrap gap-3">
        <Button loading={busy} onClick={() => void tick()}>{t('tasks.schedules.checkDue')}</Button>
      </div>
    </header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{label(error, error)}</p>}
    <Card title={t('tasks.schedules.notifications')}>
      {inbox?.notifications.length ? <ul className="space-y-3">{inbox.notifications.map(notification => <li key={notification.id}>
        <p>{notification.message}</p><p className="text-xs text-banking-navy/60">{formatDateTime(notification.createdAt)}</p>
      </li>)}</ul> : <EmptyState title={t('tasks.schedules.emptyNotifications')} description={t('tasks.schedules.emptyNotificationsDescription')} />}
    </Card>
    <Card title={t('tasks.schedules.title')}>
      {inbox?.tasks.length ? <ul className="space-y-4">{inbox.tasks.map(task => <li key={task.id} className="rounded-xl bg-banking-light p-3">
        <div className="flex justify-between"><span>{task.name}</span><Badge tone={task.status === 'DONE' ? 'success'
          : task.status === 'FAILED' ? 'danger' : task.status === 'AWAITING_CONFIRMATION' ? 'warn' : 'neutral'}>{label(`tasks.schedules.status.${task.status}`, task.status)}</Badge></div>
        <p className="mt-1 text-xs text-banking-navy/60">{label(`tasks.schedules.kind.${task.kind}`, task.kind)} · {formatDateTime(task.runAt)}</p>
        {task.dispatchError && <p className="mt-2 text-sm text-red-700">{task.dispatchError}</p>}
      </li>)}</ul> : <EmptyState title={t('tasks.schedules.empty')} description={t('tasks.schedules.emptyDescription')} />}
    </Card>
  </main>;
}
