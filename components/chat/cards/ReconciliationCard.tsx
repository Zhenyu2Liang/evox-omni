'use client';

import type { PendingActionSummary } from '@/lib/contracts/security';
import Link from 'next/link';
import type { OutOfBandAttention } from './types';
import { Badge, Button, Card, Money, type BadgeProps } from '../../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { localizeActionFieldLabel, localizeActionFieldValue, localizeChatError } from '@/lib/i18n/display';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';

export interface ReconciliationCardProps {
  action: PendingActionSummary;
  actionId?: string;
  /** Server-classified treatment: processing, recoverable or reconciliation. */
  attention: OutOfBandAttention;
  /**
   * Recovery entry — when supplied (and `actionId` is present), a recovery button is rendered for the
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
  tone: BadgeProps['tone'];
  bannerClass: string;
}

const COPY: Record<OutOfBandAttention, AttentionCopy> = {
  processing: {
    tone: 'info',
    bannerClass: 'bg-blue-50 text-banking-accent',
  },
  recoverable: {
    tone: 'warn',
    bannerClass: 'bg-amber-50 text-banking-warn',
  },
  reconciliation: {
    tone: 'warn',
    bannerClass: 'bg-amber-50 text-banking-warn',
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
 * It is deliberately DISTINCT from `ConfirmationCard` (tier badge + confirm/cancel) and `MfaCard`
 * (🔴 code entry) via an amber/blue warning banner and a left accent border — never a `StatusBadge`,
 * so it can never be confused with a live YELLOW/RED decision.
 *
 * The recovery button (only for `recoverable` / `reconciliation`) never executes a banking op in the
 * browser: it invokes the injected `onRecover` handler, which POSTs to `/api/actions/:id/recover`
 * where the server re-checks ownership and settles the action through the gateway's authorized path.
 * A `processing` row renders NO button (the work is still owned by a live continuation).
 */
export function ReconciliationCard(p: ReconciliationCardProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
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
        {t('cards.recover')}
      </Button>
    </div>
  ) : undefined;

  const accent = [accentClassFor(attention), className].filter(Boolean).join(' ');

  return (
    <Card
      className={accent}
      title={
        <span className="flex items-center gap-2">
          <span>{t(`cards.reconciliation.${attention}.title`)}</span>
          <Badge tone={copy.tone}>{t(`cards.reconciliation.${attention}.badge`)}</Badge>
        </span>
      }
      footer={footer}
    >
      <div className="flex flex-col gap-3">
        <div className={`rounded-xl px-3 py-2 text-sm ${copy.bannerClass}`}>{t(`cards.reconciliation.${attention}.body`)}</div>

        <p className="text-sm text-banking-navy/70">{t(`cards.reconciliation.${attention}.help`)}</p>
        {developerMode && attention === 'reconciliation' && <Link href="/manual" className="text-sm text-banking-accent underline">{t('cards.manualReview')}</Link>}

        <dl className="flex flex-col gap-2">
          {action.fields.map((field, index) => (
            <div
              key={`${field.label}-${index}`}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <dt className="text-banking-navy/70">{localizeActionFieldLabel(field.label, t)}</dt>
              <dd className="text-right font-medium text-banking-navy">{localizeActionFieldValue(field, t)}</dd>
            </div>
          ))}
          {typeof action.amount === 'string' ? (
            <div className="flex items-center justify-between gap-4 border-t border-banking-navy/10 pt-2 text-sm">
              <dt className="text-banking-navy/70">{t('cards.amount')}</dt>
              <dd className="font-semibold text-banking-deep">
                <Money amount={action.amount} />
              </dd>
            </div>
          ) : null}
        </dl>

        {error && showRecover ? (
          <div>
            <Badge tone="danger">{localizeChatError(error, t)}</Badge>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
