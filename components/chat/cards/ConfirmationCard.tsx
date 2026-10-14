'use client';

import type { PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import { Badge, Button, Card, StatusBadge } from '../../ui';
import { ActionDetails } from './ActionDetails';
import { asTerminalStatus, terminalStatusView } from './confirmationStatus';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { localizeActionTitle, localizeChatError } from '@/lib/i18n/display';
import { publicToolError } from '@/lib/tool-feedback';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';

export interface ConfirmationCardProps {
  action: PendingActionSummary;
  actionId?: string;
  onConfirm?: (actionId: string) => void;
  onCancel?: (actionId: string) => void;
  busy?: boolean;
  error?: string;
  /**
   * The action's current status. When TERMINAL the card reports the settled fact instead of the
   * obsolete cancel/confirm controls. The chat layer may instead stamp a runtime `status` field
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
 * This component NEVER executes money movement itself: cancel/confirm only call the handlers passed
 * from the chat container, which POST to the `./app` action routes. The SERVER re-validates the
 * original args and executes the operation through the security gateway's authorized path — the
 * browser (and the model) can never trigger a transfer directly.
 *
 * Once the action SETTLES (a terminal status), the controls are replaced by the factual status badge
 * so a settled action can never still look actionable.
 */
export function ConfirmationCard(p: ConfirmationCardProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  const { action, actionId, onConfirm, onCancel, busy, error, status, statusMessage, className } = p;

  const canCancel = Boolean(actionId && onCancel);
  const canConfirm = Boolean(actionId && onConfirm);

  const withRuntime = action as PendingActionSummaryWithRuntime;
  const terminal = asTerminalStatus(status) ?? asTerminalStatus(withRuntime.status);
  const rawReason = statusMessage ?? withRuntime.message;
  const reason = typeof rawReason === 'string' ? rawReason : undefined;
  const terminalView = terminal ? terminalStatusView(terminal, terminal === 'failed' ? publicToolError(reason, t) : undefined) : undefined;

  const footer = terminalView ? (
    <div className="flex items-center justify-end gap-2">
      <Badge tone={terminalView.tone}>{terminal ? t(`cards.terminal.${terminal}`) : terminalView.label}</Badge>
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
        {t('cards.cancel')}
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
        {t('cards.confirm')}
      </Button>
    </div>
  );

  return (
    <Card
      padding="sm"
      layout="request"
      className={className}
      title={
        <span className="flex items-center gap-2">
          <span>{localizeActionTitle(action.title, t)}</span>
          {!terminal ? <StatusBadge tier={action.tier} /> : null}
        </span>
      }
      footer={footer}
    >
      <ActionDetails action={action} />

      {terminalView?.explanation ? (
        <p className="mt-3 text-sm text-banking-navy/70">{terminal === 'needs_reconciliation' ? t('cards.terminal.reconciliationExplanation') : terminalView.explanation}</p>
      ) : null}
      {developerMode && reason ? <details className="mt-3 text-xs text-banking-navy">
        <summary>{t('chat.diagnostics.detail')}</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words">{String(sanitizeToolArguments(reason))}</pre>
      </details> : null}

      {error ? (
        <div className="mt-3">
          <Badge tone="danger">{localizeChatError(error, t)}</Badge>
        </div>
      ) : null}
    </Card>
  );
}
