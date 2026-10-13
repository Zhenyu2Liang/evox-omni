'use client';

/**
 * `/actions` — 待处理操作 (the standalone, refresh-reachable recovery page).
 *
 * WHY THIS PAGE EXISTS: after a browser refresh or a service restart the user must be able to
 * FIND the operations that still need their attention WITHOUT knowing a hidden `actionId` and
 * WITHOUT re-sending anything. The only place that shows them today is `ChatWindow` on `/agent`
 * (a mount-time fetch), and `/` `/security` `/audit` show nothing about pending actions. This
 * page surfaces the SAME server-persisted session state on its own route, so navigation alone
 * is enough to reach a pending YELLOW/RED decision, an in-flight `confirmed` continuation, a
 * recoverable result-less wedge, or a terminal `needs_reconciliation` row.
 *
 * TRANSPORT — only the two frozen `./app/api` endpoints, through the existing client helpers:
 *   `GET  /api/actions`             → `fetchPendingActions()` (cookie identity; no query params)
 *   `POST /api/actions/:id/recover` → `recoverAction(id)`
 * Both come from `@/components` and NEVER throw; a failed recovery is folded into a SAFE
 * `{ type:'error'; message }` event. This page never executes a banking op itself, never imports
 * Prisma / `banking-sdk` / `security` / `agent` / `planner`, and never renders an MFA input —
 * the confirm / MFA-code step stays on the AI 助手 page, so the server-side gate is neither
 * bypassed nor weakened here.
 *
 * EMPTY vs FAILED LOAD: `fetchPendingActions` is best-effort BY CONTRACT (it resolves `[]` on
 * ANY failure — network, non-OK status, error envelope), so the row list alone cannot tell "the
 * read failed" from "genuinely nothing to do". A concurrent reachability probe of the SAME
 * `GET /api/actions` URL supplies that distinction (`loadError`), so the user is never silently
 * told there is nothing to do when the request actually failed.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  DEFAULT_ENDPOINTS,
  EmptyState,
  Money,
  ReconciliationCard,
  StatusBadge,
  fetchPendingActions,
  recoverAction,
} from '@/components';
import type { PendingActionRef } from '@/components';

/** Generic, safe fallback shown when a recovery reports an empty failure message. */
const GENERIC_RECOVER_ERROR = '恢复执行失败，请稍后重试。';

/**
 * Reachability probe for the SAME `GET /api/actions` URL that `fetchPendingActions` reads.
 *
 * Read-only: inspects the HTTP status only (never the body) and NEVER throws — any exception or
 * non-OK status resolves to `false`. Needed because the helper is best-effort by contract and
 * collapses every failure into `[]`.
 */
async function probeActionsEndpoint(): Promise<boolean> {
  try {
    const res = await fetch(DEFAULT_ENDPOINTS.actions, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Normalize an error-event message into a safe, non-empty inline row error. */
function safeRowError(message: string): string {
  const trimmed = message.trim();
  return trimmed !== '' ? trimmed : GENERIC_RECOVER_ERROR;
}

/**
 * A row that still needs a HUMAN DECISION (`attention === 'decision'`: status `pending` /
 * `awaiting_mfa`). It is a *pointer* only: the facts come from the persisted summary, and the
 * confirm / MFA-code step is deliberately delegated to the AI 助手 page — no confirm button, no
 * code input, no way to short-circuit the gateway from here.
 */
function DecisionRow({ row }: { row: PendingActionRef }) {
  const { summary } = row;
  const needsCode = row.requiresMfa || row.status === 'awaiting_mfa';

  return (
    <Card
      className="border-l-4 border-banking-warn"
      title={
        <span className="flex items-center gap-2">
          <span>{summary.title}</span>
          {/* The tier as a Badge — `StatusBadge` IS the tier pill (single source of tier colours). */}
          <StatusBadge tier={row.tier} />
        </span>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Link
            href="/agent"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-banking-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-banking-navy"
          >
            前往确认
          </Link>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={needsCode ? 'warn' : 'info'}>{needsCode ? '待验证码' : '待确认'}</Badge>
        </div>

        <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-banking-warn">
          {needsCode
            ? '该操作需要强验证（验证码）后才能执行：请前往 AI 助手页面输入验证码完成验证，本页不提供验证码输入。'
            : '该操作需要你确认后才能执行：请前往 AI 助手页面完成确认，本页不会代替你确认。'}
        </div>

        <dl className="flex flex-col gap-2">
          {summary.fields.map((field, index) => (
            <div
              key={`${field.label}-${index}`}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <dt className="text-banking-navy/70">{field.label}</dt>
              <dd className="text-right font-medium text-banking-navy">{field.value}</dd>
            </div>
          ))}
          {summary.amount !== undefined ? (
            <div className="flex items-center justify-between gap-4 border-t border-banking-navy/10 pt-2 text-sm">
              <dt className="text-banking-navy/70">金额</dt>
              <dd className="font-semibold text-banking-deep">
                <Money amount={summary.amount} />
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </Card>
  );
}

interface ActionRowProps {
  row: PendingActionRef;
  /** This row's recovery POST is in flight. */
  busy: boolean;
  /** Safe, inline failure text for this row (never a raw exception). */
  error?: string;
  onRecover: (actionId: string) => void;
}

/**
 * Render ONE row with the treatment its `attention` class requires. Exhaustive over
 * `AttentionClass`: `processing` rows get NO `onRecover` prop at all, so a row whose live lease
 * is still held can never be re-triggered from the UI.
 */
function ActionRow({ row, busy, error, onRecover }: ActionRowProps) {
  switch (row.attention) {
    case 'processing':
      return <ReconciliationCard action={row.summary} actionId={row.id} attention="processing" />;
    case 'recoverable':
    case 'reconciliation':
      return (
        <ReconciliationCard
          action={row.summary}
          actionId={row.id}
          attention={row.attention}
          onRecover={onRecover}
          busy={busy}
          error={error}
        />
      );
    case 'decision':
      return <DecisionRow row={row} />;
  }
}

export default function ActionsPage() {
  const [rows, setRows] = useState<PendingActionRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  /** Read the session's attention rows, plus the reachability flag. NEVER throws. */
  const load = useCallback(async () => {
    const [list, reachable] = await Promise.all([fetchPendingActions(), probeActionsEndpoint()]);
    setRows(list);
    setLoadError(!reachable);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await load();
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Recover ONE out-of-band row (`POST /api/actions/:id/recover`), then ALWAYS re-read the
   * authoritative server state so the row shows its new persisted status. A domain failure is
   * reported inline (safe text only); a raw exception can never reach the UI.
   */
  const handleRecover = useCallback(
    async (actionId: string) => {
      setBusyId(actionId);
      setRowErrors((prev) => {
        if (!(actionId in prev)) return prev;
        const next = { ...prev };
        delete next[actionId];
        return next;
      });

      try {
        const res = await recoverAction(actionId);
        const failure = res.events.find((event) => event.type === 'error');
        if (failure && failure.type === 'error') {
          setRowErrors((prev) => ({ ...prev, [actionId]: safeRowError(failure.message) }));
        }
      } catch {
        // `recoverAction` never throws — belt and braces so no raw error is ever surfaced.
        setRowErrors((prev) => ({ ...prev, [actionId]: GENERIC_RECOVER_ERROR }));
      } finally {
        await load();
        setBusyId(null);
      }
    },
    [load],
  );

  const isEmpty = rows.length === 0;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-banking-deep">待处理操作</h1>
          <p className="mt-1 text-sm text-banking-navy">
            刷新页面或重启服务后，仍需要你处理的操作都会出现在这里，无需记住任何操作编号，也不必重新发送请求。
          </p>
        </div>
        <Button variant="secondary" size="md" loading={loading} onClick={() => void refresh()}>
          刷新
        </Button>
      </header>

      {loading && isEmpty ? (
        <Card>
          <p role="status" aria-live="polite" className="text-sm text-banking-navy/70">
            加载中…
          </p>
        </Card>
      ) : loadError && isEmpty ? (
        <Card className="border-l-4 border-banking-danger">
          <p role="alert" className="text-sm text-banking-danger">
            待处理操作列表加载失败（网络或会话异常）。这不代表没有待处理操作，请点击「刷新」重试。
          </p>
        </Card>
      ) : isEmpty ? (
        <EmptyState
          title="暂无待处理操作"
          description="当前会话没有待确认、处理中、可恢复或待人工核对的操作。"
        />
      ) : (
        <>
          {loadError ? (
            <Card className="border-l-4 border-banking-danger">
              <p role="alert" className="text-sm text-banking-danger">
                刷新失败，以下为最近一次成功读取的状态，请点击「刷新」重试。
              </p>
            </Card>
          ) : null}

          <div className="flex items-center gap-2">
            <Badge tone="info">共 {rows.length} 项</Badge>
          </div>

          <section className="flex flex-col gap-4">
            {rows.map((row) => (
              <ActionRow
                key={row.id}
                row={row}
                busy={busyId === row.id}
                error={rowErrors[row.id]}
                onRecover={handleRecover}
              />
            ))}
          </section>
        </>
      )}
    </main>
  );
}
