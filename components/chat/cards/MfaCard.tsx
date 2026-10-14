'use client';

import { useState } from 'react';
import { Badge, Button, Card } from '../../ui';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { asTerminalStatus } from './confirmationStatus';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { localizeActionTitle, localizeChatError, localizeVerificationHint } from '@/lib/i18n/display';
import { publicToolError } from '@/lib/tool-feedback';
import { useDeveloperMode } from '@/lib/developer-mode/DeveloperModeProvider';
import { sanitizeToolArguments } from '@/lib/tool-diagnostics';
import { ActionDetails } from './ActionDetails';

export interface MfaCardProps {
  actionId: string;
  action?: Omit<PendingActionSummary, 'toolName'>;
  status?: string;
  statusMessage?: string;
  hint?: string;
  onSubmit?: (code: string) => void;
  onCancel?: (actionId: string) => void;
  busy?: boolean;
  error?: string;
  attempts?: number;
  maxAttempts?: number;
  className?: string;
}

/**
 * RED-tier verification surface. It renders the `hint` ONLY — never an MFA code; the code is
 * typed by the user and verified server-side (this file deliberately imports nothing from
 * `@/lib/constants`, so the mock code can never leak into the UI).
 */
export function MfaCard(p: MfaCardProps) {
  const { t } = useI18n();
  const { enabled: developerMode } = useDeveloperMode();
  const { actionId, hint, onSubmit, onCancel, busy, error, attempts, maxAttempts, className } = p;
  const [code, setCode] = useState('');

  const trimmed = code.trim();
  const terminal = asTerminalStatus(p.status);
  const readOnly = terminal !== undefined || (p.status !== undefined && !['pending', 'awaiting_mfa'].includes(p.status));
  const canSubmit = /^\d{6}$/.test(trimmed) && !busy && !readOnly;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit?.(trimmed);
  };

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <Button variant="secondary" size="md" disabled={busy} onClick={() => onCancel?.(actionId)}>
        {t('cards.cancel')}
      </Button>
      <Button variant="primary" size="md" loading={busy} disabled={!canSubmit} onClick={submit}>
        {t('cards.verify')}
      </Button>
    </div>
  );

  return (
    <Card layout="request" padding="sm" className={className} title={p.action ? localizeActionTitle(p.action.title, t) : t('cards.mfa.title')} footer={readOnly ? undefined : footer}>
      <div className="flex flex-col gap-3">
        {p.action ? <ActionDetails action={p.action} /> : null}
        {terminal ? <p role="status">{t(`cards.terminal.${terminal}`)}</p> : null}
        {terminal === 'failed' ? <p className="text-sm text-banking-danger">{publicToolError(p.statusMessage, t)}</p> : null}
        {developerMode && p.statusMessage ? <details className="text-xs text-banking-navy">
          <summary>{t('chat.diagnostics.detail')}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words">{String(sanitizeToolArguments(p.statusMessage))}</pre>
        </details> : null}
        {readOnly && !terminal ? <p role="status">{t(p.status === 'locked' ? 'cards.mfa.locked' : 'cards.mfa.processing')}</p> : null}
        {!readOnly ? <p className="text-sm text-banking-navy/70">
          {hint ? localizeVerificationHint(hint, t) : t('cards.mfa.hint')}
        </p> : null}

        {!readOnly ? <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={t('cards.mfa.label')}
          placeholder={t('cards.mfa.placeholder')}
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full rounded-xl border border-banking-navy/20 bg-banking-light px-3 py-2 text-sm text-banking-navy outline-hidden transition focus:border-banking-accent disabled:opacity-60"
        /> : null}

        {typeof attempts === 'number' && attempts > 0 ? (
          <p className="text-xs text-banking-warn" role="status">
            {typeof maxAttempts === 'number'
              ? t('cards.mfa.failedAttemptsLimit', { attempts, maxAttempts })
              : t('cards.mfa.failedAttempts', { attempts })}
          </p>
        ) : null}

        {error ? <Badge tone="danger">{localizeChatError(error, t)}</Badge> : null}
      </div>
    </Card>
  );
}
