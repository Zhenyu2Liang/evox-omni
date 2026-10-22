/**
 * card-account-display — pure, hook-free reducers that turn a `CardView`'s settlement binding into
 * display decisions. Shared by `components/banking/CardTile` and `components/chat/cards/CardsCard`
 * so both render the same four-state contract from the same code.
 *
 * `CardView.linkedAccountStatus` is the ONLY source of truth for those states:
 *
 *  - `LINKED`          render 「关联账户 + 账户余额 + 可用余额」.
 *  - `MISSING`         render ONLY the 「未关联账户」 notice — no amount, never `0.00`.
 *  - `UNTRUSTED`       render ONLY the 「账户暂不可用」 notice — the account does not resolve, so its
 *                      balance is UNKNOWN; showing `0.00` would fabricate a financial fact.
 *  - `NOT_APPLICABLE`  a CREDIT card: it draws on its credit line, so the caller keeps its own
 *                      `creditLimit` / `availableLimit` rows and renders no account block.
 *
 * Card usability is ORTHOGONAL to the binding: a `FROZEN` / `LOST` card keeps its `LINKED` balances
 * visible and merely gains an 「卡片不可用」 notice — unusable is not the same as empty.
 *
 * `accountBalance` is the bound settlement ACCOUNT's cash, never a credit line and never a second
 * balance owned by the card (cards sharing an account share that one balance). `usableBalance` is
 * what THIS card may spend now — `min(account balance, remaining family monthly limit)`.
 * No masking, rounding or money arithmetic happens here: the account number is already masked
 * server-side and every amount is a CNY decimal string rendered verbatim through `ui/Money`.
 */
import type { CardLinkedAccountStatus, CardView } from '@/banking-sdk';
import type { MessageKey } from '@/lib/i18n/shared';
import type { MoneyAmount } from '@/lib/money';

/** Account fields a `LINKED` card displays; every field is `undefined` for any other state. */
export interface CardAccountDisplay {
  /** Bound settlement account display name, e.g. 活期账户. */
  accountName?: string;
  /** Already-masked account number (`****8821`), falling back to the recorded account id. */
  accountNumber?: string;
  /** The bound ACCOUNT's balance — not a credit line, not a per-card balance. */
  accountBalance?: MoneyAmount;
  /** Amount this card may spend now (`min(account balance, remaining monthly limit)`). */
  usableBalance?: MoneyAmount;
}

/** Notice key per non-displaying binding state; `LINKED` / `NOT_APPLICABLE` have nothing to explain. */
const LINKED_ACCOUNT_NOTICE: Record<CardLinkedAccountStatus, MessageKey | undefined> = {
  LINKED: undefined,
  MISSING: 'business.cards.linkedAccountMissing',
  UNTRUSTED: 'business.cards.linkedAccountUntrusted',
  NOT_APPLICABLE: undefined,
};

/** Notice key per card status, used only while the card is not `usable`. */
const CARD_UNAVAILABLE_NOTICE: Record<CardView['status'], MessageKey> = {
  ACTIVE: 'business.cards.cardUnavailable',
  FROZEN: 'business.cards.cardFrozenNotice',
  LOST: 'business.cards.cardLostNotice',
  PENDING: 'business.cards.cardUnavailable',
};

/**
 * Whether the account block (关联账户 / 账户余额 / 可用余额) may render at all — `LINKED` and nothing
 * else, so `MISSING` / `UNTRUSTED` can never fall through to a fabricated amount.
 */
export function cardShowsAccountAmounts(card: CardView): boolean {
  return card.linkedAccountStatus === 'LINKED';
}

/**
 * The account fields to display. Returns `{}` unless the binding is `LINKED`, so every consumer that
 * checks the fields (instead of the status) still renders no amount for `MISSING` / `UNTRUSTED`.
 */
export function cardAccountDisplay(card: CardView): CardAccountDisplay {
  if (card.linkedAccountStatus !== 'LINKED') return {};
  return {
    accountName: card.linkedAccountName,
    accountNumber: card.linkedAccountNumber ?? card.linkedAccountId,
    accountBalance: card.accountAvailableBalance,
    usableBalance: card.payableAmount,
  };
}

/**
 * The notice to render INSTEAD of amounts when no settlement account resolves
 * (`MISSING` → 未关联账户, `UNTRUSTED` → 账户暂不可用). `undefined` when amounts are shown or the
 * card has no settlement account by design.
 */
export function linkedAccountNoticeKey(
  status: CardLinkedAccountStatus,
): MessageKey | undefined {
  return LINKED_ACCOUNT_NOTICE[status];
}

/**
 * The notice/badge explaining that the card cannot spend right now — `FROZEN` |
 * `cardFrozenNotice`, `LOST` | `cardLostNotice`, anything else | `cardUnavailable`.
 * `undefined` while `usable`, in which case there is nothing to announce.
 */
export function cardUnavailableNoticeKey(card: CardView): MessageKey | undefined {
  return card.usable ? undefined : CARD_UNAVAILABLE_NOTICE[card.status];
}
