'use client';

import type { AnomalyReport, AnomalySeverity } from '@/banking-sdk';
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
  onFreeze?: () => void;
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

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => onAcknowledge?.()}>
                这是本人交易
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onViewDetail?.()}>
                查看详情
              </Button>
              <Button variant="danger" size="sm" onClick={() => onFreeze?.()}>
                冻结银行卡
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
