'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AgentRunSummary, RunRecoveryResponse } from '@/agent/durable/service';
import type { RuntimeEventPage, RuntimeEventRecord } from '@/lib/contracts/runtime';

interface RunListItem {
  id: string;
  status: string;
  startedAt: string;
  nextSequence: number;
  _count: { invocations: number };
}

async function requestData<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const body = await response.json() as { ok: boolean; data: T; error?: { message: string } };
  if (!response.ok || !body.ok) throw new Error(body.error?.message ?? 'The request could not be completed.');
  return body.data;
}

/** Inspect persisted execution metadata and grounded events without exposing raw model reasoning. */
export function RunHistory() {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<AgentRunSummary>();
  const [events, setEvents] = useState<RuntimeEventRecord[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const loadRuns = useCallback(async () => {
    try { setRuns((await requestData<{ runs: RunListItem[] }>('/api/runs')).runs); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to load runs.'); }
  }, []);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const inspect = async (id: string) => {
    setBusy(true);
    setSelected(id);
    setDetail(undefined);
    setEvents([]);
    setNotice('');
    try {
      const [summary, page] = await Promise.all([
        requestData<AgentRunSummary>(`/api/runs/${encodeURIComponent(id)}`),
        requestData<RuntimeEventPage>(`/api/runs/${encodeURIComponent(id)}/events?after=0&limit=100`),
      ]);
      setDetail(summary); setEvents(page.events); setCursor(page.nextSequence); setHasMore(page.hasMore); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to inspect this run.'); }
    finally { setBusy(false); }
  };

  const loadMore = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const page = await requestData<RuntimeEventPage>(`/api/runs/${encodeURIComponent(selected)}/events?after=${cursor}&limit=100`);
      setEvents(previous => [...previous, ...page.events]); setCursor(page.nextSequence); setHasMore(page.hasMore); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to load events.'); }
    finally { setBusy(false); }
  };

  const recover = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await requestData<RunRecoveryResponse>(`/api/runs/${encodeURIComponent(selected)}/recover`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      setDetail(result.run); setNotice(result.message); setError(''); await loadRuns();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to recover this run.'); }
    finally { setBusy(false); }
  };

  return <div className="flex flex-col gap-5">
    <header className="flex items-start justify-between gap-4">
      <div><h1 className="text-2xl font-semibold text-banking-deep">Agent runs</h1>
        <p className="mt-1 text-sm text-banking-navy">Persisted calls, execution states, and grounded presentation events for this conversation.</p></div>
      <button className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={() => void loadRuns()}>Refresh</button>
    </header>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {notice && <p role="status" className="rounded bg-blue-50 p-3 text-sm">{notice}</p>}
    <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
      <section className="flex flex-col gap-2" aria-label="Run list">
        {runs.length === 0 && <p className="text-sm">Start an agent conversation to create a run.</p>}
        {runs.map(run => <button key={run.id} disabled={busy} onClick={() => void inspect(run.id)}
          className={`rounded-lg border p-3 text-left ${selected === run.id ? 'border-banking-accent bg-blue-50' : 'bg-white'}`}>
          <span className="block font-medium">{run.status}</span>
          <time className="block text-xs">{new Date(run.startedAt).toLocaleString()}</time>
          <span className="block text-xs">{run._count.invocations} calls · {run.nextSequence} recorded events</span>
          <span className="block truncate font-mono text-xs">{run.id}</span>
        </button>)}
      </section>
      <section className="min-w-0 rounded-lg border bg-white p-4" aria-label="Run details">
        {!detail ? <p className="text-sm">Select a run to inspect its saved execution history.</p> : <>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div><h2 className="font-semibold">{detail.status}</h2><p className="font-mono text-xs">{detail.id}</p></div>
            {['interrupted', 'failed', 'waiting_confirmation', 'waiting_verification'].includes(detail.status) &&
              <button disabled={busy} onClick={() => void recover()} className="rounded bg-banking-accent px-3 py-2 text-sm text-white">Recover saved results</button>}
          </div>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm">
            <thead><tr><th className="py-2">Tool</th><th>Status</th><th>Replay policy</th><th>Attempts</th></tr></thead>
            <tbody>{detail.invocations.map(invocation => <tr key={invocation.id} className="border-t">
              <td className="py-2 font-mono">{invocation.ordinal}. {invocation.toolName}</td><td>{invocation.status}</td>
              <td>{invocation.replaySafety}</td><td>{invocation.attempt}/{invocation.maxAttempts}</td>
            </tr>)}</tbody>
          </table></div>
          <h3 className="mb-2 mt-5 font-semibold">Presentation events</h3>
          <ol className="max-h-96 space-y-2 overflow-auto font-mono text-xs">
            {events.map(event => <li key={event.id} className="rounded bg-slate-50 p-2">
              <span className="font-semibold">#{event.sequence} {event.eventType}</span>
              <pre className="mt-1 whitespace-pre-wrap break-words">{JSON.stringify(event.payload, null, 2)}</pre>
            </li>)}
          </ol>
          <button disabled={busy} onClick={() => void loadMore()} className="mt-3 rounded border px-3 py-2 text-sm">
            {hasMore ? 'Load more events' : 'Check for new events'}
          </button>
        </>}
      </section>
    </div>
  </div>;
}
