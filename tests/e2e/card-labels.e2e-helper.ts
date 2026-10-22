/**
 * `tests/e2e/card-labels.e2e-helper.ts` — the SINGLE source of the Chinese `CardTile` / `CardConsumeDialog`
 * row labels that the browser acceptance assertions key on.
 *
 * WHY THIS MODULE EXISTS: `readCardTileRows` and `readDialogRows` build a
 * `Record<renderedLabel, renderedValue>` straight out of the DOM, so every assertion is a lookup such as
 * `rows[CARD_LABEL.accountBalance]`. Hard-coding those labels at the call site meant a catalogue rename
 * silently turned the lookup into `undefined` (the assertion then compared `undefined` against a value
 * and failed for the wrong reason — or, worse, an assertion on absence passed vacuously).
 *
 * The labels are read from the ONE catalog the components actually render from —
 * `lib/i18n/messages/business.zh-CN.json` — through `createTranslator('zh-CN')`, exactly the precedent
 * already used by `banking-pages.e2e-helper.ts`, `card-freeze.e2e-helper.ts` and the ten other
 * `*.e2e-helper.ts` modules. Nothing here is a copy of a catalogue string.
 *
 * Imported by `live-virtual-card.e2e-helper.ts`, `card-replace-chain.e2e-helper.ts` and
 * `live-acceptance.e2e.ts`; carries no `*.test.`/`*.spec.` suffix and is never collected by Vitest.
 */
import { createTranslator } from '../../lib/i18n/shared';

const t = createTranslator('zh-CN');

/**
 * Labels the CURRENT `components/banking/CardTile.tsx` and `app/cards/CardConsumeDialog.tsx` render,
 * mapped to the i18n key behind each one.
 *
 * - `accountBalance` (`business.cards.accountBalance`) carries `CardView.accountAvailableBalance` — the
 *   linked ACCOUNT's cash. The amount is account cash even for a virtual card: a virtual card is a debit
 *   instrument drawing on that account, never a credit line.
 * - `usableBalance` (`business.cards.usableBalance`) carries `CardView.payableAmount` — the amount the
 *   card can actually be charged right now, `min(account cash, remaining monthly limit)`.
 * - `creditLimit` / `availableLimit` are CREDIT-only rows. Their presence on a non-credit card is a bug
 *   signature asserted against, NOT a stale label.
 */
export const CARD_LABEL = {
  /** `business.cards.linkedAccount` — rendered as a `<span>` + name/number, not a `<dt>` row. */
  linkedAccount: t('business.cards.linkedAccount'),
  /** `business.cards.accountBalance` — a `<dt>` row (account cash). */
  accountBalance: t('business.cards.accountBalance'),
  /** `business.cards.usableBalance` — a `<dt>` row (spendable now). */
  usableBalance: t('business.cards.usableBalance'),
  /** `business.cards.monthlyLimit` — a `<span>` label on cards carrying a monthly limit. */
  monthlyLimit: t('business.cards.monthlyLimit'),
  /** `business.cards.limit` — CREDIT cards only. */
  creditLimit: t('business.cards.limit'),
  /** `business.cards.available` — CREDIT cards only. */
  availableLimit: t('business.cards.available'),
  /** `business.cards.linkedAccountMissing` — `linkedAccountStatus === 'MISSING'` notice, no amounts. */
  linkedAccountMissing: t('business.cards.linkedAccountMissing'),
  /** `business.cards.linkedAccountUntrusted` — `linkedAccountStatus === 'UNTRUSTED'` notice, no amounts. */
  linkedAccountUntrusted: t('business.cards.linkedAccountUntrusted'),
} as const;

/**
 * Labels the components render NOWHERE any more. They stay in the catalogue, so an assertion can prove
 * they are gone instead of merely forgetting them: a tile or consume-dialog summary that still shows
 * `账户可用余额` / `当前可支付金额` is rendering a superseded contract.
 */
export const CARD_LABEL_RETIRED = {
  /** `business.cards.accountAvailable` — superseded by {@link CARD_LABEL.accountBalance}. */
  accountAvailable: t('business.cards.accountAvailable'),
  /** `business.cards.payableAmount` — superseded by {@link CARD_LABEL.usableBalance}. */
  payableAmount: t('business.cards.payableAmount'),
} as const;
