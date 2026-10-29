/**
 * Banking SDK — public facade.
 *
 * The SINGLE layer that turns banking intent into Prisma writes (via `lib/db/repositories`).
 * Execute-only: permission / confirmation / MFA / daily-limit policy is NOT decided here — that
 * belongs to the Security Gateway (`security/`). Functions validate domain invariants (funds,
 * `minAmount`, recipient resolution) and throw typed `AppError`.
 *
 * Usage: `import { banking } from '<root>/banking-sdk'; await banking.account.getBalance(userId);`
 */
import * as account from './account';
import * as report from './bill-report';
import * as budget from './budget';
import * as card from './card';
import * as contact from './contact';
import * as dashboard from './dashboard';
import * as investment from './investment';
import * as subscription from './subscription';
import * as task from './task';
import * as transaction from './transaction';
import * as transfer from './transfer';

/** Grouped access to every banking capability module. */
export const banking = {
  report,
  account,
  transaction,
  transfer,
  contact,
  card,
  subscription,
  investment,
  budget,
  task,
  dashboard,
};

/** Public DTOs / view models (see `./types`). */
export * from './types';
export type { BillReport, BillReportQuery, BillReportEntry, ReportTotals } from './bill-report';

/**
 * 「净值 + 份额」 math (see `./net-value`): `NET_VALUE_DECIMALS`, `SHARE_DECIMALS`,
 * `sharesFromAmount`, `marketValueFromShares`, `settlementFromShares`, `redeemedCostMinor`,
 * `remainingSharesOf`, `floorToShares`, `profitRateOf` and the redemption fee rule. Pure functions
 * with no I/O, re-exported so callers quote exactly what the SDK settles.
 */
export * from './net-value';
/**
 * Exact, bounded proportional redemption valuation (see `./valuation`). Re-exported so the Security
 * Gateway mints the SAME `expectedRedemptionAmount` the SDK settles.
 */
export { redemptionPortionValuation, remainingPortionMarketValue, settledRedemptionAmount } from './valuation';

export type { ExecutionFenceCheck } from './fence';
export { withBankingExecution } from './execution-context';
export type { BankingExecutionContext } from './execution-context';
