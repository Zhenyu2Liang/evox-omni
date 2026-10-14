import { CHAT_HISTORY_PAGE_SIZE, type ChatHistoryPage } from '@/lib/contracts/chat-history';
import { isChatHistoryPage } from './history';

export type HistoryRequestResult = { kind: 'page'; page: ChatHistoryPage } | { kind: 'changed' } | { kind: 'failed' };

/** Read-only pagination never retries automatically or changes the selected workspace. */
export async function requestOlderHistory(endpoint: string, cursor: string, signal: AbortSignal): Promise<HistoryRequestResult> {
  return requestHistory(endpoint, cursor, signal);
}

/** Reconcile a disconnected stream with saved messages without submitting another operation. */
export async function requestLatestHistory(endpoint: string, signal: AbortSignal): Promise<HistoryRequestResult> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal.aborted) cancel();
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 5000);
  try { return await requestHistory(endpoint, undefined, abort.signal); }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}

async function requestHistory(endpoint: string, cursor: string | undefined, signal: AbortSignal): Promise<HistoryRequestResult> {
  try {
    const separator = endpoint.includes('?') ? '&' : '?';
    const cursorQuery = cursor === undefined ? '' : `cursor=${encodeURIComponent(cursor)}&`;
    const response = await fetch(`${endpoint}${separator}${cursorQuery}limit=${CHAT_HISTORY_PAGE_SIZE}`, { cache: 'no-store', signal });
    if (response.status === 409) return { kind: 'changed' };
    if (!response.ok) return { kind: 'failed' };
    const envelope: unknown = await response.json();
    if (!envelope || typeof envelope !== 'object' || !('ok' in envelope) || envelope.ok !== true ||
        !('data' in envelope) || !isChatHistoryPage(envelope.data)) return { kind: 'failed' };
    return { kind: 'page', page: envelope.data };
  } catch { return { kind: 'failed' }; }
}
