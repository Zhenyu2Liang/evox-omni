/**
 * Chat card payload contracts.
 *
 * Concrete payload shapes for the `data: unknown` fields of the frozen `ChatCard` union
 * (`lib/contracts/agent.ts`), plus the action-handler bundle threaded from the chat container
 * into interactive cards.
 *
 * These are the frozen public contract of the `./components/chat/cards` node. They are declared
 * here (and re-exported from `./index.ts`) so the `./app` chat serialiser and the card renderers
 * agree on the exact shapes. Some may be unused yet — that is intentional.
 */
import type {
  AnomalyReport,
  BalanceView,
  CardView,
  HoldingView,
  InvestmentComparison,
  ProductView,
  SpendingAnalysis,
  SubscriptionView,
  TransferResult,
} from '@/banking-sdk';

export interface BalanceCardData {
  balance: BalanceView;
}

export interface TransferCardData {
  result: TransferResult;
}

export interface SpendingCardData {
  analysis: SpendingAnalysis;
}

export interface CardsCardData {
  cards: CardView[];
}

export interface InvestmentsCardData {
  products?: ProductView[];
  holdings?: HoldingView[];
  comparison?: InvestmentComparison;
}

export interface SubscriptionsCardData {
  subscriptions: SubscriptionView[];
}

export interface AnomalyCardData {
  report: AnomalyReport;
}

/** Control action requested from a plan card's task-control buttons. */
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'retry';

/**
 * How the chat surface must treat a restored `GET /api/actions` row. It is additive on top of the
 * row `status` (a legacy server that omits it is handled by deriving it from `status`):
 *  - `decision`       — a LIVE human decision (`pending` / `awaiting_mfa`) → confirm/MFA card.
 *  - `processing`     — a `confirmed` row with an ACTIVE execution lease (work still in flight;
 *                       nothing for the user to do, just show it is being processed).
 *  - `recoverable`    — a result-less `confirmed` wedge with NO live lease that the server can
 *                       safely settle on request (e.g. an idempotent `transfer_money` replay) →
 *                       the user may trigger recovery.
 *  - `reconciliation` — a terminal `needs_reconciliation` row whose outcome is UNKNOWN and must be
 *                       settled out-of-band / through the recovery entry.
 */
export type AttentionClass = 'decision' | 'processing' | 'recoverable' | 'reconciliation';

/**
 * The out-of-band attention states rendered by the non-decision `ReconciliationCard`
 * (`processing` / `recoverable` / `reconciliation`) — i.e. every class EXCEPT `decision`.
 */
export type OutOfBandAttention = Exclude<AttentionClass, 'decision'>;

/** Callbacks threaded from the chat container into interactive cards. */
export interface CardActionHandlers {
  actionId?: string;
  onConfirm?: (actionId: string) => void;
  onVerify?: (actionId: string, code: string) => void;
  onCancel?: (actionId: string) => void;
  onAcknowledge?: () => void; // anomaly: 这是本人交易
  onViewDetail?: () => void; // anomaly: 查看详情
  onFreeze?: () => void; // anomaly: 冻结银行卡
  onTaskControl?: (action: TaskControlAction) => void; // plan: pause/resume/cancel/retry
  onRecover?: (actionId: string) => void; // out-of-band: POST /api/actions/:id/recover
  mfaAttempts?: number; // MFA: number of failed verification attempts so far
  busy?: boolean;
  error?: string;
}
