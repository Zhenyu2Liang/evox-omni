/** Current browser action contracts reject obsolete payloads without inventing controls. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmAction, fetchPendingActions, fetchTaskPlan, PENDING_ACTION_READ_TIMEOUT_MS, sendChatTurn } from '@/components/chat/actions';

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'action-1', sessionId: 'session-1', toolName: 'transfer_money', args: { amount: '200.00' },
    status: 'pending', tier: 'YELLOW', requiresMfa: false, attention: 'decision', createdAt: 1, updatedAt: 1,
    summary: {
      actionId: 'action-1', title: 'Transfer confirmation', toolName: 'transfer_money', tier: 'YELLOW',
      requiresMfa: false, amount: '200.00', fields: [{ label: 'Amount', value: '200.00' }],
    },
    ...overrides,
  };
}

function respond(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('current pending action response contract', () => {
  it('accepts the current envelope and preserves its complete summary', async () => {
    const row = action();
    respond({ ok: true, data: [row] });
    expect(await fetchPendingActions()).toEqual([{
      id: row.id, status: row.status, tier: row.tier, requiresMfa: row.requiresMfa,
      attention: row.attention, summary: row.summary,
    }]);
    expect(fetch).toHaveBeenCalledWith('/api/actions', { method: 'GET', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) });
  });

  it.each([
    ['pending', 'decision'], ['awaiting_mfa', 'decision'], ['confirmed', 'processing'],
    ['confirmed', 'recoverable'], ['confirmed', 'reconciliation'], ['needs_reconciliation', 'reconciliation'],
  ])('preserves explicit current status %s and attention %s', async (status, attention) => {
    respond({ ok: true, data: [action({ status, attention })] });
    expect(await fetchPendingActions()).toMatchObject([{ status, attention }]);
  });

  it('rejects a missing attention field rather than deriving a decision', async () => {
    respond({ ok: true, data: [action({ attention: undefined })] });
    expect(await fetchPendingActions()).toEqual([]);
  });

  it('rejects a flat summary view rather than reconstructing a summary', async () => {
    const row = action();
    respond({ ok: true, data: [{ ...row, ...(row.summary as Record<string, unknown>), summary: undefined }] });
    expect(await fetchPendingActions()).toEqual([]);
  });

  it('rejects the riskLevel alias even when the nested summary carries a tier', async () => {
    respond({ ok: true, data: [action({ tier: undefined, riskLevel: 'YELLOW' })] });
    expect(await fetchPendingActions()).toEqual([]);
  });

  it.each(['raw-array', 'raw-actions', 'wrapped-actions', 'missing-envelope-data'])('rejects obsolete response shape %s', async (shape) => {
    const rows = [action()];
    const body = shape === 'raw-array' ? rows : shape === 'raw-actions' ? { actions: rows }
      : shape === 'wrapped-actions' ? { ok: true, data: { actions: rows } } : { ok: true };
    respond(body);
    expect(await fetchPendingActions()).toEqual([]);
  });

  it.each([
    { id: '' }, { requiresMfa: undefined }, { tier: 'UNKNOWN' }, { summary: undefined },
    { toolName: undefined }, { attention: 'UNKNOWN' }, { status: 'executed' },
    { status: 'confirmed', attention: 'decision' }, { status: 'needs_reconciliation', attention: 'recoverable' },
  ])('drops malformed row %j without inventing policy or controls', async (overrides) => {
    respond({ ok: true, data: [action(overrides)] });
    expect(await fetchPendingActions()).toEqual([]);
  });

  it.each([
    { toolName: '' }, { toolName: 'unknown_tool' }, { tier: 'RED' }, { requiresMfa: true },
    { actionId: 'another-action' }, { title: '' }, { fields: undefined },
    { fields: [{ label: 'Amount', value: 200 }] }, { amount: 200 },
  ])('rejects inconsistent summary %j without coercion', async (overrides) => {
    const row = action();
    respond({ ok: true, data: [{ ...row, summary: { ...(row.summary as Record<string, unknown>), ...overrides } }] });
    expect(await fetchPendingActions()).toEqual([]);
  });

  it('retains valid rows while discarding malformed rows', async () => {
    respond({ ok: true, data: [action({ attention: undefined }), action()] });
    expect(await fetchPendingActions()).toHaveLength(1);
  });

  it.each([200, 403, 500])('returns an empty read for a current error envelope with HTTP %s', async (status) => {
    respond({ ok: false, error: { code: 'SECURITY_DENIED', message: 'Session unavailable' } }, status);
    expect(await fetchPendingActions()).toEqual([]);
  });

  it('returns an empty read on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection unavailable')));
    expect(await fetchPendingActions()).toEqual([]);
  });

  it('bounds a fetch that never resolves even when the transport ignores abort', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetcher);
    let completed = false;
    const response = fetchPendingActions().then(refs => { completed = true; return refs; });
    await vi.advanceTimersByTimeAsync(PENDING_ACTION_READ_TIMEOUT_MS - 1);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await response).toEqual([]);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a response body that never finishes decoding JSON', async () => {
    vi.useFakeTimers();
    const response = { ok: true, json: () => new Promise<unknown>(() => undefined) } as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const result = fetchPendingActions();
    await vi.advanceTimersByTimeAsync(PENDING_ACTION_READ_TIMEOUT_MS);
    expect(await result).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an obsolete restoration immediately and ignores its late successful rows', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const abort = new AbortController();
    const result = fetchPendingActions(undefined, abort.signal);
    abort.abort();
    expect(await result).toEqual([]);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    finish(Response.json({ ok: true, data: [action()] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a request for an already aborted restoration', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const abort = new AbortController(); abort.abort();
    expect(await fetchPendingActions(undefined, abort.signal)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cleans up its deadline after a successful restoration and allows the next StrictMode read', async () => {
    vi.useFakeTimers();
    const abort = new AbortController(); abort.abort();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, data: [action()] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchPendingActions(undefined, abort.signal)).toEqual([]);
    expect(await fetchPendingActions(undefined, new AbortController().signal)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('current shared response envelope', () => {
  it('settles a locked verification instead of leaving an active input', async () => {
    respond({ ok: true, data: { ok: false, sessionId: 'session-1', actionId: 'action-1',
      status: 'locked', tier: 'RED', requiresMfa: true, message: 'Verification locked', mfaResult: 'failed', events: [] } });
    expect((await confirmAction('action-1')).events).toEqual([
      { type: 'error', message: 'Verification locked' },
      { type: 'action_settled', actionId: 'action-1', status: 'locked', message: 'Verification locked' },
    ]);
  });
  it('rejects a raw task plan rather than adapting it', async () => {
    respond({ id: 'plan-1', nodes: [], results: [] });
    expect(await fetchTaskPlan('plan-1')).toBeUndefined();
  });

  it('rejects raw chat events rather than applying them', async () => {
    respond({ sessionId: 'session-1', events: [{ type: 'mfa_required', actionId: 'action-1' }] });
    const result = await sendChatTurn({ message: 'Read balance', sessionId: 'session-1' });
    expect(result.events).toMatchObject([{ type: 'error' }]);
    expect(result.events.some(event => event.type === 'mfa_required')).toBe(false);
  });

  it('preserves the current server error envelope message', async () => {
    respond({ ok: false, error: { code: 'CONFLICT', message: 'Action already completed' } }, 409);
    expect((await confirmAction('action-1')).events).toEqual([{ type: 'error', message: 'Action already completed', code: 'CONFLICT' }]);
  });

  it('preserves current MFA escalation from an action response', async () => {
    respond({ ok: true, data: { ok: false, sessionId: 'session-1', actionId: 'action-1',
      status: 'awaiting_mfa', tier: 'RED', requiresMfa: true, message: 'Verification required', events: [] } });
    expect((await confirmAction('action-1')).events).toEqual([{ type: 'mfa_required', actionId: 'action-1' }]);
  });

  it.each(['actionId', 'sessionId', 'ok', 'status', 'tier', 'requiresMfa', 'message', 'events'])(
    'rejects an incomplete action response without %s', async (field) => {
      const data: Record<string, unknown> = { ok: false, sessionId: 'session-1', actionId: 'action-1',
        status: 'awaiting_mfa', tier: 'RED', requiresMfa: true, message: 'Verification required', events: [] };
      delete data[field];
      respond({ ok: true, data });
      expect((await confirmAction('action-1')).events).toMatchObject([{ type: 'error' }]);
    },
  );

  it('emits the typed current settlement and does not reopen terminal MFA', async () => {
    respond({ ok: true, data: { ok: true, sessionId: 'session-1', actionId: 'action-1',
      status: 'executed', tier: 'RED', requiresMfa: true, message: 'Transfer completed',
      events: [{ type: 'mfa_required', actionId: 'action-1' }] } });
    expect((await confirmAction('action-1')).events).toEqual([
      { type: 'action_settled', actionId: 'action-1', status: 'executed', message: 'Transfer completed' },
    ]);
  });
});
