'use client';

import type { SpendingAnalysis } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { Card } from '../../ui/Card';
import { Money } from '../../ui/Money';
import { EmptyState } from '../../ui/EmptyState';
import { SpendingPie, SpendingTrend } from '../../charts';

export interface SpendingCardProps {
  data: SpendingAnalysis;
  className?: string;
}

/**
 * Spending analysis card: total + month-over-month change, category-share and trend charts
 * (composed from `../../charts`), the top merchant and the largest single transaction.
 * Renders an `EmptyState` when the analysis carries nothing to display.
 */
export function SpendingCard({ data, className }: SpendingCardProps) {
  const hasCategories = data.byCategory.length > 0;
  const hasTrend = data.monthlyTrend.length > 0;
  const hasContent = hasCategories || hasTrend || data.topMerchant !== null || data.largest !== null;

  if (!hasContent) {
    return (
      <Card className={className} padding="md">
        <EmptyState
          title="暂无消费数据"
          description={`${data.month} 没有可分析的消费记录。`}
        />
      </Card>
    );
  }

  const momUp = data.momChangePct > 0;
  const momFlat = data.momChangePct === 0;
  const momClass = momFlat ? 'text-slate-500' : momUp ? 'text-banking-danger' : 'text-banking-success';
  const momText = `${momUp ? '+' : ''}${data.momChangePct.toFixed(1)}%`;

  return (
    <Card
      className={className}
      title={`${data.month} 消费分析`}
      description="正常消费分类与趋势（不含异常交易及投资资金流）"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <div className="text-xs text-slate-500">正常消费</div>
            <Money amount={data.total} className="text-2xl font-semibold text-banking-deep" />
          </div>
          <div>
            <div className="text-xs text-slate-500">上月支出</div>
            <Money amount={data.prevTotal} className="text-base text-slate-600" />
          </div>
          <div>
            <div className="text-xs text-slate-500">环比</div>
            <span className={`text-base font-medium ${momClass}`}>{momText}</span>
          </div>
        </div>

        {(hasCategories || hasTrend) && (
          <div className="grid gap-4 md:grid-cols-2">
            {hasCategories && <SpendingPie data={data.byCategory} height={200} />}
            {hasTrend && <SpendingTrend data={data.monthlyTrend} height={200} />}
          </div>
        )}

        {data.topMerchant && (
          <div className="rounded-xl bg-banking-light p-3">
            <div className="text-xs text-slate-500">最高消费商户</div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="font-medium text-banking-navy">{data.topMerchant.merchant}</span>
              <span className="flex items-center gap-2">
                <Money amount={data.topMerchant.amount} className="font-semibold text-banking-deep" />
                <span className="text-xs text-slate-500">{data.topMerchant.count} 笔</span>
              </span>
            </div>
          </div>
        )}

        {data.largest && (
          <div className="rounded-xl bg-banking-light p-3">
            <div className="text-xs text-slate-500">最大单笔交易</div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="font-medium text-banking-navy">{data.largest.merchant}</span>
              <Money amount={data.largest.amount} signed className="font-semibold text-banking-deep" />
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {data.largest.category} · {formatDateTime(data.largest.occurredAt)}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
