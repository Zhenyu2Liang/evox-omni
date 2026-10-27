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
import { ApprovalRecord } from './ApprovalRecord';
import { ErrorCard } from './ErrorCard';
import { InvestmentsCard } from './InvestmentsCard';
import { PlanCard } from './PlanCard';
import { SpendingCard } from './SpendingCard';
import { SubscriptionsCard } from './SubscriptionsCard';
import { TransferCard } from './TransferCard';
import { TransactionsCard } from './TransactionsCard';
import { BusinessReceiptCard, ContactsCard, DashboardCard, ScheduledCard } from './BusinessResultCards';

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
  return <div data-chat-card-type={p.card.type}>{renderCard(p)}</div>;
}

function renderCard(p: CardRendererProps) {
  switch (p.card.type) {
    case 'balance':
      return <BalanceCard data={p.card.data as BalanceView} className={p.className} />;
    case 'transfer':
      return <TransferCard data={p.card.data as TransferResult} className={p.className} />;
    case 'transactions':
      return <TransactionsCard data={p.card.data as TransactionView[]} />;
    case 'confirmation':
      return (
        <ApprovalRecord
          action={p.card.action}
          actionId={p.card.action.actionId}
          status={(p.card.action as typeof p.card.action & { status?: unknown }).status}
          message={(p.card.action as typeof p.card.action & { message?: string }).message}
          className={p.className}
        />
      );
    case 'mfa': {
      const { actionId } = p.card;
      return (
        <ApprovalRecord
          actionId={actionId}
          action={p.card.action}
          status={p.card.status}
          message={p.card.message}
          verification
          className={p.className}
        />
      );
    }
    case 'spending':
      return <SpendingCard data={p.card.data as SpendingAnalysis} className={p.className} />;
    case 'cards':
      return <CardsCard data={p.card.data as CardView[]} issuanceActionId={p.card.issuanceActionId} className={p.className} />;
    case 'investments':
      return <InvestmentsCard data={p.card.data as InvestmentsCardData} className={p.className} />;
    case 'subscriptions':
      return <SubscriptionsCard data={p.card.data as SubscriptionView[]} className={p.className} />;
    case 'contacts':
      return <ContactsCard data={p.card.data} className={p.className} />;
    case 'dashboard':
      return <DashboardCard data={p.card.data} className={p.className} />;
    case 'scheduled':
      return <ScheduledCard data={p.card.data} created={p.card.created} className={p.className} />;
    case 'receipt':
      return <BusinessReceiptCard data={p.card.data} className={p.className} />;
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
    case 'plan': {
      const plan = p.card.plan;
      return (
        <PlanCard
          plan={plan}
          onControl={p.action?.onTaskControl ? action => p.action?.onTaskControl?.(action, plan.id) : undefined}
          busy={p.action?.busy}
          className={p.className}
        />
      );
    }
    case 'error':
      return <ErrorCard message={p.card.message} code={p.card.code} className={p.className} />;
    default:
      return assertNever(p.card);
  }
}

function assertNever(x: never): never {
  throw new Error('Unhandled ChatCard variant: ' + JSON.stringify(x));
}
