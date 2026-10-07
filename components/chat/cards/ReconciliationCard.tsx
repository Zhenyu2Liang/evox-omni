'use client';

import type { PendingActionSummary } from '@/lib/contracts/security';
import { Badge, Card, Money } from '../../ui';

export interface ReconciliationCardProps {
  action: PendingActionSummary;
  actionId?: string;
  className?: string;
}

/**
 * TERMINAL `needs_reconciliation` surface.
 *
 * A gated side effect MAY have committed but its outcome could not be recorded, so a HUMAN must
 * reconcile it out-of-band. This card is intentionally ACTIONLESS: there is NO 确认 / 取消, NO code
 * input and NO button that sends a chat message — the operation must never be re-invoked, and the
 * browser must never execute a banking op. It only states the situation and echoes the original
 * action context so the user can check the ledger.
 *
 * It is deliberately DISTINCT from `ConfirmationCard` (🟡 tier badge + 确认/取消) and `MfaCard`
 * (🔴 code entry) via an amber warning banner and a left accent border — never a `StatusBadge`, so
 * it can never be confused with a live YELLOW/RED decision.
 */
export function ReconciliationCard(p: ReconciliationCardProps) {
  const { action, className } = p;

  const accent = ['border-l-4 border-banking-warn', className].filter(Boolean).join(' ');

  return (
    <Card
      className={accent}
      title={
        <span className="flex items-center gap-2">
          <span>该操作需要人工核对</span>
          <Badge tone="warn">需人工核对</Badge>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-banking-warn">
          该操作可能已经执行，但其执行结果未能记录，系统无法自动判定成功或失败。为避免重复执行，本操作不会被自动重试。
        </div>

        <p className="text-sm text-banking-navy/70">请核对账户流水，如需帮助请联系客服人工处理。</p>

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
          {typeof action.amount === 'number' ? (
            <div className="flex items-center justify-between gap-4 border-t border-banking-navy/10 pt-2 text-sm">
              <dt className="text-banking-navy/70">金额</dt>
              <dd className="font-semibold text-banking-deep">
                <Money amount={action.amount} />
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </Card>
  );
}
