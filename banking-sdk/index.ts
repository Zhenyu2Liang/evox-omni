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

/** Execution-fence carrier (see `./fence`) — a server-generated check awaited inside the write tx. */
export * from './fence';
export { withBankingExecution } from './execution-context';
export type { BankingExecutionContext } from './execution-context';
