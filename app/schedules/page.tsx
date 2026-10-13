'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ScheduleInbox } from '@/lib/contracts/schedule';
import { Badge, Button, Card, EmptyState } from '@/components/ui';
import { formatDateTime } from '@/lib/date';

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const envelope = await response.json();
  if (!response.ok || envelope.ok !== true) throw new Error(envelope.error?.message ?? 'The schedule request failed.');
  return envelope.data as T;
}

export default function SchedulesPage() {
  const [inbox, setInbox] = useState<ScheduleInbox>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => setInbox(await request<ScheduleInbox>('/api/schedules')), []);
  useEffect(() => { void load().catch(issue => setError(issue instanceof Error ? issue.message : 'Loading failed.')); }, [load]);

  async function tick() {
    setBusy(true); setError('');
    try { await request('/api/schedules/tick', {}); await load(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Dispatch failed.'); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-4xl space-y-6 p-6">
    <header className="space-y-3">
      <h1 className="text-2xl font-semibold text-banking-deep">{'\u5b9a\u65f6\u4efb\u52a1\u4e0e\u63d0\u9192'}</h1>
      <p className="text-sm text-banking-navy">{'\u5230\u671f\u63d0\u9192\u8fdb\u5165\u901a\u77e5\u6536\u4ef6\u7bb1\uff1b\u5230\u671f\u4ed8\u6b3e\u4f1a\u91cd\u65b0\u8bc4\u4f30\u98ce\u9669\u5e76\u7b49\u5f85\u7528\u6237\u786e\u8ba4\u6216\u9a8c\u8bc1\u3002'}</p>
      <div className="flex gap-3">
        <Button loading={busy} onClick={() => void tick()}>{'\u68c0\u67e5\u5230\u671f\u4efb\u52a1'}</Button>
        <Link href="/agent" className="self-center text-sm text-banking-accent underline">{'\u5230 AI \u52a9\u624b\u786e\u8ba4\u64cd\u4f5c'}</Link>
      </div>
    </header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{error}</p>}
    <Card title={'\u63d0\u9192\u901a\u77e5'}>
      {inbox?.notifications.length ? <ul className="space-y-3">{inbox.notifications.map(notification => <li key={notification.id}>
        <p>{notification.message}</p><p className="text-xs text-banking-navy/60">{formatDateTime(notification.createdAt)}</p>
      </li>)}</ul> : <EmptyState title={'\u6682\u65e0\u5df2\u9001\u8fbe\u63d0\u9192'} />}
    </Card>
    <Card title={'\u5b9a\u65f6\u4efb\u52a1'}>
      {inbox?.tasks.length ? <ul className="space-y-4">{inbox.tasks.map(task => <li key={task.id} className="rounded-xl bg-banking-light p-3">
        <div className="flex justify-between"><span>{task.name}</span><Badge tone={task.status === 'DONE' ? 'success'
          : task.status === 'FAILED' ? 'danger' : task.status === 'AWAITING_CONFIRMATION' ? 'warn' : 'neutral'}>{task.status}</Badge></div>
        <p className="mt-1 text-xs text-banking-navy/60">{task.kind} · {formatDateTime(task.runAt)}</p>
        {task.dispatchError && <p className="mt-2 text-sm text-red-700">{task.dispatchError}</p>}
      </li>)}</ul> : <EmptyState title={'\u6682\u65e0\u5b9a\u65f6\u4efb\u52a1'} />}
    </Card>
  </main>;
}
