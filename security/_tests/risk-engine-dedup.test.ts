/**
 * Unit: security/risk-engine — ledger dedup of the in-flight transfer total.
 *
 * `computeInFlightTransferTotal` sums the amounts of a user's parked `transfer_money`
 * PendingActions that have been AUTHORIZED (status `confirmed`) but not yet written to the ledger.
 * Its input is the JSON `argsJson` blob of each row, and — crucially — it must EXCLUDE any action
 * whose deterministic ledger `Transaction` row (`idempotentTransferTxId(userId, action.id)`) ALREADY
 * exists, because such an action is already counted by the EXECUTED daily total. Without this dedup
 * a "ledgered but not yet terminal" action is counted twice and spuriously escalates a following
 * legitimately-YELLOW transfer to RED/MFA.
 *
 * DB-free: the Prisma surface is a hand-written STUB that implements only the two calls the helper
 * makes (`pendingAction.findMany` + `transaction.findMany`) and honours the `where` filters it uses.
 *
 * Run: `npx vitest run --config security/_vitest.local.config.ts`
 */
import { describe, it, expect } from 'vitest';

import { computeInFlightTransferTotal, type PrismaLike } from '../risk-engine';
import { idempotentTransferTxId } from '../../lib/ledger';

const USER_ID = 'user_liming';

interface PendingRow {
  id: string;
  userId: string;
  toolName: string;
  status: string;
  argsJson: string;
}

/** Build a parked `transfer_money` row exactly as the gateway would persist it. */
function parkedTransfer(
  id: string,
  amount: number,
  opts: { userId?: string; status?: string; toolName?: string; argsJson?: string } = {},
): PendingRow {
  return {
    id,
    userId: opts.userId ?? USER_ID,
    toolName: opts.toolName ?? 'transfer_money',
    status: opts.status ?? 'confirmed',
    argsJson: opts.argsJson ?? JSON.stringify({ name: '张伟', amount }),
  };
}

/**
 * A minimal `PrismaLike` stub: `pendingAction.findMany` applies the filters the helper uses
 * (userId / toolName / status.in / id.not) and `transaction.findMany` returns the ledger rows that
 * exist out of the requested `id.in` list.
 */
function stubClient(rows: PendingRow[], ledgerRows: Iterable<string> = []): PrismaLike {
  const ledger = new Set(ledgerRows);
  const stub = {
    pendingAction: {
      findMany: async (query: { where?: Record<string, any> } = {}) => {
        const where = query.where ?? {};
        return rows.filter((row) => {
          if (where.userId !== undefined && row.userId !== where.userId) return false;
          if (where.toolName !== undefined && row.toolName !== where.toolName) return false;
          if (where.status?.in !== undefined && !where.status.in.includes(row.status)) return false;
          if (where.id?.not !== undefined && row.id === where.id.not) return false;
          return true;
        });
      },
    },
    transaction: {
      findMany: async (query: { where?: { id?: { in?: string[] } } } = {}) => {
        const ids = query.where?.id?.in ?? [];
        return ids.filter((id) => ledger.has(id)).map((id) => ({ id }));
      },
    },
  };
  return stub as unknown as PrismaLike;
}

describe('risk-engine · computeInFlightTransferTotal · ledger dedup', () => {
  it('EXCLUDES an in-flight action whose ledger row already exists (counted once, via executed)', async () => {
    const action = parkedTransfer('act_ledgered', 600);
    const client = stubClient([action], [idempotentTransferTxId(USER_ID, 'act_ledgered')]);

    expect(await computeInFlightTransferTotal(client, USER_ID)).toBe(0);
  });

  it('COUNTS an in-flight action with no ledger row yet', async () => {
    const client = stubClient([parkedTransfer('act_parked', 600)]);

    expect(await computeInFlightTransferTotal(client, USER_ID)).toBe(600);
  });

  it('preserves the concurrency defence: two ¥600 in-flight actions with NO ledger rows sum to ¥1200', async () => {
    const client = stubClient([parkedTransfer('act_a', 600), parkedTransfer('act_b', 600)]);

    // Both are still parked (never ledgered), so both count → the second confirm sees 1200 > 1000 → RED.
    expect(await computeInFlightTransferTotal(client, USER_ID)).toBe(1200);
  });

  it('still drops the action being evaluated via excludeActionId', async () => {
    const client = stubClient([parkedTransfer('act_a', 600), parkedTransfer('act_b', 600)]);

    expect(await computeInFlightTransferTotal(client, USER_ID, 'act_a')).toBe(600);
  });

  it('counts only the un-ledgered side of a mix (A ledgered, B not)', async () => {
    const client = stubClient(
      [parkedTransfer('act_a', 600), parkedTransfer('act_b', 600)],
      [idempotentTransferTxId(USER_ID, 'act_a')],
    );

    expect(await computeInFlightTransferTotal(client, USER_ID)).toBe(600);
  });

  it('applies the ledger dedup together with excludeActionId', async () => {
    const client = stubClient(
      [parkedTransfer('act_a', 600), parkedTransfer('act_b', 600), parkedTransfer('act_c', 300)],
      [idempotentTransferTxId(USER_ID, 'act_a')],
    );

    // A is ledgered (dropped by dedup), B is the action being evaluated (dropped by exclude) → only C.
    expect(await computeInFlightTransferTotal(client, USER_ID, 'act_b')).toBe(300);
  });

  it('skips a malformed/non-finite amount rather than throwing', async () => {
    const client = stubClient([
      parkedTransfer('act_bad_json', 0, { argsJson: '{ not json' }),
      parkedTransfer('act_bad_amount', 0, { argsJson: JSON.stringify({ amount: 'abc' }) }),
      parkedTransfer('act_ok', 250),
    ]);

    expect(await computeInFlightTransferTotal(client, USER_ID)).toBe(250);
  });

  it('scopes to the given userId and to transfer_money actions only', async () => {
    const client = stubClient([
      parkedTransfer('act_mine', 100),
      parkedTransfer('act_other_user', 700, { userId: 'user_other' }),
      parkedTransfer('act_other_tool', 800, { toolName: 'set_card_limit' }),
      parkedTransfer('act_pending', 900, { status: 'pending' }),
    ]);

    expect(await computeInFlightTransferTotal(client, USER_ID)).toBe(100);
  });

  it('returns 0 without querying the ledger when there are no in-flight rows', async () => {
    let ledgerQueried = false;
    const client = {
      pendingAction: { findMany: async () => [] },
      transaction: {
        findMany: async () => {
          ledgerQueried = true;
          return [];
        },
      },
    } as unknown as PrismaLike;

    expect(await computeInFlightTransferTotal(client, USER_ID)).toBe(0);
    expect(ledgerQueried).toBe(false);
  });
});
