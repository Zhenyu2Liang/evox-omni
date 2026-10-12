'use client';

import type { PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import { Badge, Button, Card, Money, StatusBadge } from '../../ui';
import { asTerminalStatus, terminalStatusView } from './confirmationStatus';

export interface ConfirmationCardProps {
  action: PendingActionSummary;
  actionId?: string;
  onConfirm?: (actionId: string) => void;
  onCancel?: (actionId: string) => void;
  busy?: boolean;
  error?: string;
  /**
   * The action's current status. When TERMINAL the card reports the settled fact instead of the
   * (now meaningless) 取消/确认 controls. The chat layer may instead stamp a runtime `status` field
   * onto `action` (the frozen `PendingActionSummary` has no such field) — this prop wins over it.
   */
  status?: PendingActionStatus;
  /** Optional one-line explanation for a terminal status (e.g. the failure reason). */
  statusMessage?: string;
  className?: string;
}

/**
 * `PendingActionSummary` plus the non-contract, runtime-only fields the chat layer stamps onto an
 * inline card's `action` object after settlement. Read structurally (never declared in the frozen
 * contract).
 */
type PendingActionSummaryWithRuntime = PendingActionSummary & {
  status?: unknown;
  message?: unknown;
};

/**
 * YELLOW/RED confirmation surface for a gated banking action.
 *
 * This component NEVER executes money movement itself: [取消]/[确认] only call the handlers passed
 * from the chat container, which POST to the `./app` action routes. The SERVER re-validates the
 * original args and executes the operation through the security gateway's authorized path — the
 * browser (and the model) can never trigger a transfer directly.
 *
 * Once the action SETTLES (a terminal status), the controls are replaced by the factual status badge
 * so a settled action can never still look actionable.
 */
export function ConfirmationCard(p: ConfirmationCardProps) {
  const { action, actionId, onConfirm, onCancel, busy, error, status, statusMessage, className } = p;

  const canCancel = Boolean(actionId && onCancel);
  const canConfirm = Boolean(actionId && onConfirm);

  const withRuntime = action as PendingActionSummaryWithRuntime;
  const terminal = asTerminalStatus(status) ?? asTerminalStatus(withRuntime.status);
  const rawReason = statusMessage ?? withRuntime.message;
  const reason = typeof rawReason === 'string' ? rawReason : undefined;
  const terminalView = terminal ? terminalStatusView(terminal, reason) : undefined;

  const footer = terminalView ? (
    <div className="flex items-center justify-end gap-2">
      <Badge tone={terminalView.tone}>{terminalView.label}</Badge>
    </div>
  ) : (
    <div className="flex items-center justify-end gap-2">
      <Button
        variant="secondary"
        size="md"
        disabled={busy || !canCancel}
        onClick={() => {
          if (actionId && onCancel) onCancel(actionId);
        }}
      >
        取消
      </Button>
      <Button
        variant="primary"
        size="md"
        loading={busy}
        disabled={busy || !canConfirm}
        onClick={() => {
          if (actionId && onConfirm) onConfirm(actionId);
        }}
      >
        确认
      </Button>
    </div>
  );

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-2">
          <span>{action.title}</span>
          <StatusBadge tier={action.tier} />
        </span>
      }
      footer={footer}
    >
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
        {typeof action.amount === 'number' && !action.fields.some(field => field.label === '金额') ? (
          <div className="flex items-center justify-between gap-4 border-t border-banking-navy/10 pt-2 text-sm">
            <dt className="text-banking-navy/70">金额</dt>
            <dd className="font-semibold text-banking-deep">
              <Money amount={action.amount} />
            </dd>
          </div>
        ) : null}
      </dl>

      {terminalView?.explanation ? (
        <p className="mt-3 text-sm text-banking-navy/70">{terminalView.explanation}</p>
      ) : null}

      {error ? (
        <div className="mt-3">
          <Badge tone="danger">{error}</Badge>
        </div>
      ) : null}
    </Card>
  );
}
