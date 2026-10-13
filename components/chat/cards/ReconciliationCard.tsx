'use client';

import type { PendingActionSummary } from '@/lib/contracts/security';
import Link from 'next/link';
import type { OutOfBandAttention } from './types';
import { Badge, Button, Card, Money, type BadgeProps } from '../../ui';

export interface ReconciliationCardProps {
  action: PendingActionSummary;
  actionId?: string;
  /** Server-classified treatment: processing, recoverable or reconciliation. */
  attention: OutOfBandAttention;
  /**
   * Recovery entry — when supplied (and `actionId` is present), a 恢复执行 button is rendered for the
   * `recoverable` / `reconciliation` states. It calls the injected handler ONLY (which POSTs to
   * `/api/actions/:id/recover`); the browser never replays a banking op itself.
   */
  onRecover?: (actionId: string) => void;
  busy?: boolean;
  error?: string;
  className?: string;
}

/** Per-state copy + tone. The `Record<OutOfBandAttention, …>` makes a new class a compile error. */
interface AttentionCopy {
  title: string;
  badge: string;
  tone: BadgeProps['tone'];
  bannerClass: string;
  body: string;
  help: string;
}

const COPY: Record<OutOfBandAttention, AttentionCopy> = {
  processing: {
    title: '该操作正在处理中',
    badge: '处理中',
    tone: 'info',
    bannerClass: 'bg-blue-50 text-banking-accent',
    body: '该操作已确认，服务器正在处理中。请稍候，处理完成后状态会自动更新；无需重复提交。',
    help: '如需了解处理进度，请稍后刷新或联系客服查询。',
  },
  recoverable: {
    title: '该操作可以恢复',
    badge: '可恢复',
    tone: 'warn',
    bannerClass: 'bg-amber-50 text-banking-warn',
    body: '该操作此前可能已提交，但结果未能记录，系统判定该操作可安全重试。点击「恢复执行」由服务器重新核对并补记结果。',
    help: '恢复执行不会重复扣款：服务器仅在确认无记录时才补记一次结果。',
  },
  reconciliation: {
    title: '该操作需要人工核对',
    badge: '待人工核对',
    tone: 'warn',
    bannerClass: 'bg-amber-50 text-banking-warn',
    body: '该操作可能已经执行，但其执行结果未能记录，系统无法自动判定成功或失败。为避免重复执行，本操作不会被自动重试。',
    help: '请核对账户流水，可进入人工处理登记核对说明；结果不明时不能重新执行。',
  },
};

/** Exhaustiveness guard: a new `OutOfBandAttention` variant must break the build here. */
function assertNever(x: never): never {
  throw new Error('Unhandled attention class: ' + JSON.stringify(x));
}

/** Left accent colour for a state — an exhaustive switch so a new class is a `tsc` error. */
function accentClassFor(attention: OutOfBandAttention): string {
  switch (attention) {
    case 'processing':
      return 'border-l-4 border-banking-accent';
    case 'recoverable':
    case 'reconciliation':
      return 'border-l-4 border-banking-warn';
    default:
      return assertNever(attention);
  }
}

/**
 * Out-of-band attention surface for a restored non-decision action.
 *
 * It is deliberately DISTINCT from `ConfirmationCard` (🟡 tier badge + 确认/取消) and `MfaCard`
 * (🔴 code entry) via an amber/blue warning banner and a left accent border — never a `StatusBadge`,
 * so it can never be confused with a live YELLOW/RED decision.
 *
 * The 恢复执行 button (only for `recoverable` / `reconciliation`) never executes a banking op in the
 * browser: it invokes the injected `onRecover` handler, which POSTs to `/api/actions/:id/recover`
 * where the server re-checks ownership and settles the action through the gateway's authorized path.
 * A `processing` row renders NO button (the work is still owned by a live continuation).
 */
export function ReconciliationCard(p: ReconciliationCardProps) {
  const { action, actionId, attention, onRecover, busy, error, className } = p;

  const copy = COPY[attention];
  const canRecover = Boolean(actionId && onRecover);
  const showRecover = attention !== 'processing' && canRecover;

  const footer = showRecover ? (
    <div className="flex items-center justify-end gap-2">
      <Button
        variant="primary"
        size="md"
        loading={busy}
        disabled={busy}
        onClick={() => {
          if (actionId && onRecover) onRecover(actionId);
        }}
      >
        恢复执行
      </Button>
    </div>
  ) : undefined;

  const accent = [accentClassFor(attention), className].filter(Boolean).join(' ');

  return (
    <Card
      className={accent}
      title={
        <span className="flex items-center gap-2">
          <span>{copy.title}</span>
          <Badge tone={copy.tone}>{copy.badge}</Badge>
        </span>
      }
      footer={footer}
    >
      <div className="flex flex-col gap-3">
        <div className={`rounded-xl px-3 py-2 text-sm ${copy.bannerClass}`}>{copy.body}</div>

        <p className="text-sm text-banking-navy/70">{copy.help}</p>
        {attention === 'reconciliation' && <Link href="/manual" className="text-sm text-banking-accent underline">转人工处理</Link>}

        <dl className="flex flex-col gap-2">
          {action.fields.map((field, index) => (
            <div
              key={`${field.label}-${index}`}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <dt className="text-banking-navy/70">{field.label}</dt>
              <dd className="text-right font-medium text-banking-navy">{field.value}</dd>
            </div>
          ))}
          {typeof action.amount === 'string' ? (
            <div className="flex items-center justify-between gap-4 border-t border-banking-navy/10 pt-2 text-sm">
              <dt className="text-banking-navy/70">金额</dt>
              <dd className="font-semibold text-banking-deep">
                <Money amount={action.amount} />
              </dd>
            </div>
          ) : null}
        </dl>

        {error && showRecover ? (
          <div>
            <Badge tone="danger">{error}</Badge>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
