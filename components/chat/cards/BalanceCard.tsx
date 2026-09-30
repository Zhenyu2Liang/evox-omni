'use client';

import type { BalanceView } from '@/banking-sdk';
import { Card, EmptyState, Money } from '../../ui';

export interface BalanceCardProps {
  data: BalanceView;
  className?: string;
}

export function BalanceCard({ data, className }: BalanceCardProps) {
  const { totalAvailable, currency, accounts } = data;

  return (
    <Card title="账户余额" className={className}>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-banking-navy/70">可用余额</span>
        <span className="text-3xl font-semibold text-banking-deep">
          <Money amount={totalAvailable} />
        </span>
        <span className="text-xs text-banking-navy/60">{currency}</span>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          className="mt-4"
          title="暂无账户"
          description="该用户名下没有可展示的银行账户。"
        />
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between rounded-xl bg-banking-light px-4 py-3"
            >
              <div className="flex flex-col">
                <span className="font-medium text-banking-deep">{account.name}</span>
                <span className="text-xs text-banking-navy/60">{account.numberMasked}</span>
              </div>
              <span className="font-medium text-banking-deep">
                <Money amount={account.balance} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
