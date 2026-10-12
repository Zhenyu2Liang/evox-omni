'use client';

import type { AnomalyReport, AnomalySeverity, AnomalyItem } from '@/banking-sdk';
import { useState } from 'react';
import { formatDateTime } from '@/lib/date';
import { Card } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Money } from '../../ui/Money';
import { EmptyState } from '../../ui/EmptyState';

export interface AnomalyCardProps {
  data: AnomalyReport;
  onAcknowledge?: () => void;
  onViewDetail?: () => void;
  onFreeze?: (anomaly: AnomalyItem, cardId: string) => void;
  className?: string;
}

const SEVERITY_LABEL: Record<AnomalySeverity, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

function severityTone(severity: AnomalySeverity): 'danger' | 'warn' | 'neutral' {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warn';
  return 'neutral';
}

/**
 * Anomaly report card: a warning header, one block per flagged transaction (merchant, amount via
 * `Money`, reason and severity) plus the three in-card actions (这是本人交易 / 查看详情 / 冻结银行卡).
 * Renders an `EmptyState` when no anomaly was detected. The actions only call injected callbacks —
 * the browser never performs a banking operation here.
 */
export function AnomalyCard({ data, onAcknowledge, onViewDetail, onFreeze, className }: AnomalyCardProps) {
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
      if (!response.ok || !result.ok) throw new Error(result.error?.message ?? '确认失败');
      setAcknowledged(ids => [...ids, anomaly.transaction.id]);
      onAcknowledge?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '确认失败'); }
    finally { setBusy(false); }
  }
  if (data.anomalies.length === 0) {
    return (
      <Card className={className} padding="md">
        <EmptyState
          title="未发现可疑交易"
          description={`已扫描 ${data.scanned} 笔交易，未发现异常。`}
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
          异常交易提醒
          <Badge tone={highCount > 0 ? 'danger' : 'warn'}>{data.anomalies.length} 笔</Badge>
        </span>
      }
      description={`已扫描 ${data.scanned} 笔交易，发现 ${data.anomalies.length} 笔可疑交易。`}
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
                <div className="mt-0.5 text-xs text-slate-500">
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
                    风险 {SEVERITY_LABEL[anomaly.severity]}
                  </Badge>
                </div>
              </div>
            </div>

            <p className="mt-2 text-sm text-slate-600">{anomaly.reason}</p>
            {expanded === anomaly.transaction.id ? <dl className="mt-2 text-xs space-y-1">
              <div>交易编号：{anomaly.transaction.id}</div><div>账户：{anomaly.transaction.accountId}</div>
              <div>渠道：{anomaly.transaction.channel ?? '未提供'}</div><div>备注：{anomaly.transaction.remark ?? '无'}</div>
            </dl> : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={busy || anomaly.acknowledged || acknowledged.includes(anomaly.transaction.id)} onClick={() => void acknowledge(anomaly)}>
                {anomaly.acknowledged || acknowledged.includes(anomaly.transaction.id) ? '已确认本人交易' : '这是本人交易'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setExpanded(anomaly.transaction.id); onViewDetail?.(); }}>
                查看详情
              </Button>
              <select aria-label="选择要冻结的卡片" value={selectedCard} onChange={event => setSelectedCard(event.target.value)} className="text-xs rounded border px-2">
                <option value="">选择要冻结的卡片</option>
                {(data.cards ?? []).map(card => <option key={card.id} value={card.id}>{card.type} {card.numberMasked}</option>)}
              </select>
              <Button variant="danger" size="sm" disabled={!selectedCard} onClick={() => onFreeze?.(anomaly, selectedCard)}>
                冻结银行卡
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
