'use client';

import { useState } from 'react';
import { Badge, Button, Card } from '../../ui';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { asTerminalStatus } from './confirmationStatus';

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
        取消
      </Button>
      <Button variant="primary" size="md" loading={busy} disabled={!canSubmit} onClick={submit}>
        验证
      </Button>
    </div>
  );

  return (
    <Card className={className} title="身份验证" footer={readOnly ? undefined : footer}>
      <div className="flex flex-col gap-3">
        {p.action ? <dl className="space-y-2 text-sm">{p.action.fields.map((field, index) =>
          <div key={`${field.label}-${index}`} className="flex justify-between gap-3"><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl> : null}
        {terminal ? <p role="status">{p.statusMessage ?? ({ executed: '已执行', failed: '执行失败', cancelled: '已取消', confirmed: '已确认', locked: '已锁定', needs_reconciliation: '待核对' }[terminal])}</p> : null}
        {readOnly && !terminal ? <p role="status">{p.status === 'locked' ? '已锁定，请到安全中心处理。' : '处理中，请在待处理操作中核对。'}</p> : null}
        {!readOnly ? <p className="text-sm text-banking-navy/70">
          {hint ?? '该操作属于高风险操作，请输入短信验证码完成验证。'}
        </p> : null}

        {!readOnly ? <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="验证码"
          placeholder="请输入验证码"
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full rounded-xl border border-banking-navy/20 bg-banking-light px-3 py-2 text-sm text-banking-navy outline-none transition focus:border-banking-accent disabled:opacity-60"
        /> : null}

        {typeof attempts === 'number' && attempts > 0 ? (
          <p className="text-xs text-banking-warn" role="status">
            验证失败，已尝试 {attempts} 次
            {typeof maxAttempts === 'number' ? `（共 ${maxAttempts} 次）` : ''}
          </p>
        ) : null}

        {error ? <Badge tone="danger">{error}</Badge> : null}
      </div>
    </Card>
  );
}
