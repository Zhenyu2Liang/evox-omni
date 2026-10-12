'use client';

import type { ChatCard } from '@/lib/contracts/agent';
import type {
  AnomalyReport,
  BalanceView,
  CardView,
  SpendingAnalysis,
  SubscriptionView,
  TransferResult,
  TransactionView,
} from '@/banking-sdk';
import type { CardActionHandlers, InvestmentsCardData } from './types';
import { AnomalyCard } from './AnomalyCard';
import { BalanceCard } from './BalanceCard';
import { CardsCard } from './CardsCard';
import { ConfirmationCard } from './ConfirmationCard';
import { ErrorCard } from './ErrorCard';
import { InvestmentsCard } from './InvestmentsCard';
import { MfaCard } from './MfaCard';
import { PlanCard } from './PlanCard';
import { SpendingCard } from './SpendingCard';
import { SubscriptionsCard } from './SubscriptionsCard';
import { TransferCard } from './TransferCard';
import { TransactionsCard } from './TransactionsCard';

export interface CardRendererProps {
  card: ChatCard;
  action?: CardActionHandlers;
  className?: string;
}

/**
 * Exhaustive dispatcher for the frozen `ChatCard` union. The `default` branch is `assertNever`,
 * so adding or removing a `ChatCard` variant is a COMPILE ERROR here.
 */
export function CardRenderer(p: CardRendererProps) {
  switch (p.card.type) {
    case 'balance':
      return <BalanceCard data={p.card.data as BalanceView} className={p.className} />;
    case 'transfer':
      return <TransferCard data={p.card.data as TransferResult} className={p.className} />;
    case 'transactions':
      return <TransactionsCard data={p.card.data as TransactionView[]} />;
    case 'confirmation':
      return (
        <ConfirmationCard
          action={p.card.action}
          actionId={p.card.action.actionId ?? p.action?.actionId}
          onConfirm={p.action?.onConfirm}
          onCancel={p.action?.onCancel}
          busy={p.action?.busy}
          error={p.card.action.actionId === p.action?.actionId ? p.action?.error : undefined}
          className={p.className}
        />
      );
    case 'mfa': {
      const { actionId, hint } = p.card;
      return (
        <MfaCard
          actionId={actionId}
          action={p.card.action}
          status={p.card.status}
          statusMessage={p.card.message}
          hint={hint}
          onSubmit={(code: string) => p.action?.onVerify?.(actionId, code)}
          onCancel={p.action?.onCancel}
          busy={p.action?.busy}
          error={actionId === p.action?.actionId ? p.action?.error : undefined}
          attempts={actionId === p.action?.actionId ? p.action?.mfaAttempts : undefined}
          className={p.className}
        />
      );
    }
    case 'spending':
      return <SpendingCard data={p.card.data as SpendingAnalysis} className={p.className} />;
    case 'cards':
      return <CardsCard data={p.card.data as CardView[]} className={p.className} />;
    case 'investments':
      return <InvestmentsCard data={p.card.data as InvestmentsCardData} className={p.className} />;
    case 'subscriptions':
      return <SubscriptionsCard data={p.card.data as SubscriptionView[]} className={p.className} />;
    case 'anomaly':
      return (
        <AnomalyCard
          data={p.card.data as AnomalyReport}
          onAcknowledge={p.action?.onAcknowledge}
          onViewDetail={p.action?.onViewDetail}
          onFreeze={p.action?.onFreeze}
          className={p.className}
        />
      );
    case 'plan':
      return (
        <PlanCard
          plan={p.card.plan}
          onControl={p.action?.onTaskControl}
          busy={p.action?.busy}
          className={p.className}
        />
      );
    case 'error':
      return <ErrorCard message={p.card.message} className={p.className} />;
    default:
      return assertNever(p.card);
  }
}

function assertNever(x: never): never {
  throw new Error('Unhandled ChatCard variant: ' + JSON.stringify(x));
}
