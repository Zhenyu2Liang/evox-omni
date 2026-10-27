'use client';

import type { AnomalyReport, AnomalySeverity, AnomalyItem } from '@/banking-sdk';
import { useState } from 'react';
import { formatDateTime } from '@/lib/date';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { EmptyState } from '../../ui/EmptyState';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface AnomalyCardProps {
  data: AnomalyReport;
  onAcknowledge?: () => void;
  onViewDetail?: () => void;
  onFreeze?: (anomaly: AnomalyItem, cardId: string) => void;
  className?: string;
}

function severityTone(severity: AnomalySeverity): 'danger' | 'warn' | 'neutral' {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warn';
  return 'neutral';
}

/**
 * Anomaly report card: a warning header, one block per flagged transaction (merchant, amount via
 * `Money`, reason and severity) plus acknowledge, view details and freeze card actions.
 * Renders an `EmptyState` when no anomaly was detected. The actions only call injected callbacks —
 * the browser never performs a banking operation here.
 */
export function AnomalyCard({ data, onAcknowledge, onViewDetail, onFreeze, className }: AnomalyCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<string>();
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [selectedCard, setSelectedCard] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function acknowledge(anomaly: AnomalyItem) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/transactions/${encodeURIComponent(anomaly.transaction.id)}/acknowledge`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error?.message ?? t('cards.anomaly.acknowledgeFailed'));
      setAcknowledged(ids => [...ids, anomaly.transaction.id]);
      onAcknowledge?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('cards.anomaly.acknowledgeFailed')); }
    finally { setBusy(false); }
  }
  if (data.anomalies.length === 0) {
    return (
      <Card className={className} padding="md">
        <EmptyState
          title={t('cards.anomaly.empty.title')}
          description={t('cards.anomaly.empty.description', { count: data.scanned })}
        />
      </Card>
    );
  }

  const highCount = data.anomalies.filter((a) => a.severity === 'high').length;

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-2">
          {t('cards.anomaly.title')}
          <Badge tone={highCount > 0 ? 'danger' : 'warn'}>{t('cards.transaction.count', { count: data.anomalies.length })}</Badge>
        </span>
      }
      description={t('cards.anomaly.description', { scanned: data.scanned, count: data.anomalies.length })}
    >
      <div className="space-y-3">
        {error ? <p role="alert">{error}</p> : null}
        {data.anomalies.map((anomaly) => (
          <div
            key={anomaly.transaction.id}
            className="rounded-xl border border-banking-danger/20 bg-banking-light p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-banking-navy">{anomaly.transaction.merchant}</div>
                <div className="mt-0.5 text-banking-caption text-banking-navy">
                  {anomaly.transaction.category} · {formatDateTime(anomaly.transaction.occurredAt)}
                </div>
              </div>
              <div className="flex-none text-right">
                <Money
                  amount={anomaly.transaction.amount}
                  signed
                  className="font-semibold text-banking-danger"
                />
                <div className="mt-1">
                  <Badge tone={severityTone(anomaly.severity)}>
                    {t(`cards.anomaly.risk.${anomaly.severity}`)}
                  </Badge>
                </div>
              </div>
            </div>

            <p className="mt-2 text-sm text-banking-navy">{anomaly.reason}</p>
            {expanded === anomaly.transaction.id ? <dl className="mt-2 text-banking-caption space-y-1">
              <div>{t('cards.anomaly.transactionId', { id: anomaly.transaction.id })}</div><div>{t('cards.anomaly.account', { id: anomaly.transaction.accountId })}</div>
              <div>{t('cards.anomaly.channel', { channel: anomaly.transaction.channel ?? t('cards.notProvided') })}</div><div>{t('cards.anomaly.remark', { remark: anomaly.transaction.remark ?? t('cards.none') })}</div>
            </dl> : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={busy || anomaly.acknowledged || acknowledged.includes(anomaly.transaction.id)} onClick={() => void acknowledge(anomaly)}>
                {t(anomaly.acknowledged || acknowledged.includes(anomaly.transaction.id) ? 'cards.anomaly.acknowledged' : 'cards.anomaly.acknowledge')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setExpanded(anomaly.transaction.id); onViewDetail?.(); }}>
                {t('cards.anomaly.details')}
              </Button>
              <select aria-label={t('cards.anomaly.selectCard')} value={selectedCard} onChange={event => setSelectedCard(event.target.value)} className="bank-input rounded-sm border border-banking-border px-2 text-banking-caption">
                <option value="">{t('cards.anomaly.selectCard')}</option>
                {(data.cards ?? []).map(card => <option key={card.id} value={card.id}>{card.type} {card.numberMasked}</option>)}
              </select>
              <Button variant="danger" size="sm" disabled={!selectedCard} onClick={() => onFreeze?.(anomaly, selectedCard)}>
                {t('cards.anomaly.freeze')}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
