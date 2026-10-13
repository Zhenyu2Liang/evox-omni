/**
 * banking-sdk · at-most-once (idempotent) CREATE helper.
 *
 * Proves the shared replay helper `banking-sdk/idempotent.ts` gives EXACTLY-ONCE semantics for the
 * two gated CREATE side effects that a plan node may re-run (`budget.reserveBudget` → `Budget`,
 * `task.createScheduledTask` → `ScheduledTask`), both keyed on the `idempotencyKey @unique` column:
 *
 *   - pure: `isUniqueViolation` (strict structural `P2002` check) and `normalizeIdempotencyKey`
 *     (trimmed, absent for empty/whitespace).
 *   - `createIdempotent` driven DIRECTLY against a real table (Budget): the first call inserts, a
 *     repeat with the SAME key replays the persisted row WITHOUT calling `create` again; a lost
 *     `P2002` race re-reads the winner's committed row; any other error propagates and writes nothing.
 *   - through the SDK barrel: `reserveBudget` / `createScheduledTask` replay on a repeated key
 *     (same `id`, exactly ONE row), and create independent rows when the key is
 *     absent, empty/whitespace-only, or a different key is used.
 *
 * DB-backed: uses the isolated test SQLite via `../../helpers/db` (fresh canonical fixtures per case).
 */
import { describe, expect, it, vi } from 'vitest';
import { banking } from '@/banking-sdk';
import type { CreateScheduledTaskInput, ReserveBudgetInput } from '@/banking-sdk';
import {
  createIdempotent,
  isUniqueViolation,
  normalizeIdempotencyKey,
} from '@/banking-sdk/idempotent';
import type { Tx } from '@/banking-sdk/tx';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// Fresh seeded DB before each case + Prisma disconnect afterwards (registers beforeEach/afterAll).
useFreshDatabase();

function db() {
  return getTestPrisma();
}

/** A finite epoch-ms run time for the scheduled-task cases. */
const RUN_AT = 1_790_000_000_000;

/** Await `fn`, returning whatever it rejected with; fails loudly if it unexpectedly resolves. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/* ------------------------------------------------------------------ pure helpers */

describe('banking-sdk · idempotent: isUniqueViolation', () => {
  it('is true ONLY for a structural P2002 code (strict string compare)', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('P2002')).toBe(false);
    expect(isUniqueViolation({ code: 2002 })).toBe(false);
  });
});

describe('banking-sdk · idempotent: normalizeIdempotencyKey', () => {
  it('trims a supplied key and treats absent/empty/whitespace as no key', () => {
    expect(normalizeIdempotencyKey('  k  ')).toBe('k');
    expect(normalizeIdempotencyKey('key')).toBe('key');
    expect(normalizeIdempotencyKey('')).toBeUndefined();
    expect(normalizeIdempotencyKey('   ')).toBeUndefined();
    expect(normalizeIdempotencyKey(undefined)).toBeUndefined();
  });
});

/* -------------------------------------------------------------- createIdempotent */

describe('banking-sdk · idempotent: createIdempotent (direct, real Budget table)', () => {
  it('inserts once and replays the persisted row without calling create again', async () => {
    const key = 'unit:direct:replay';
    const create = vi.fn(async (tx: Tx, replayKey: string) =>
      tx.budget.create({
        data: {
          userId: DEMO_USER_ID,
          name: '直接幂等',
          amountMinor: 30_000n,
          status: 'RESERVED',
          idempotencyKey: replayKey,
        },
      }),
    );
    const spec = {
      key,
      find: (tx: Tx) => tx.budget.findUnique({ where: { userId_idempotencyKey: { userId: DEMO_USER_ID, idempotencyKey: key } } }),
      create,
    };

    const first = await createIdempotent(spec);
    const second = await createIdempotent(spec);

    // The insert happened exactly once; the replay returned the SAME row.
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.id).toBe(first.id);
    expect(second.amountMinor).toBe(30_000n);
    expect(await db().budget.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('replays the winner when our create loses the P2002 unique race (nothing written by us)', async () => {
    const key = 'unit:direct:race';
    // The concurrent winner commits its row BEFORE our insert hits the UNIQUE column.
    const winner = await db().budget.create({
      data: {
        userId: DEMO_USER_ID,
        name: 'race-winner',
        amountMinor: 10_000n,
        status: 'RESERVED',
        idempotencyKey: key,
      },
    });

    let findCalls = 0;
    const create = vi.fn(async () => {
      // Real P2002 shape: an Error carrying `.code = 'P2002'`.
      throw Object.assign(new Error('Unique constraint failed on the fields: (`idempotencyKey`)'), {
        code: 'P2002',
      });
    });

    const replayed = await createIdempotent({
      key,
      find: (tx) => {
        findCalls += 1;
        // The in-transaction read saw nothing (winner uncommitted); the post-race re-read sees it.
        return findCalls === 1
          ? Promise.resolve(null)
          : tx.budget.findUnique({ where: { userId_idempotencyKey: { userId: DEMO_USER_ID, idempotencyKey: key } } });
      },
      create,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(replayed.id).toBe(winner.id);
    expect(await db().budget.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('propagates a non-unique error untouched and writes nothing', async () => {
    const key = 'unit:direct:boom';

    const error = await capture(() =>
      createIdempotent({
        key,
        find: (tx) => tx.budget.findUnique({ where: { userId_idempotencyKey: { userId: DEMO_USER_ID, idempotencyKey: key } } }),
        create: async () => {
          throw new Error('boom');
        },
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('boom');
    expect(await db().budget.count({ where: { idempotencyKey: key } })).toBe(0);
  });
});

/* ---------------------------------------------------------------- reserveBudget */

describe('banking-sdk · idempotent: reserveBudget', () => {
  it('same idempotencyKey twice returns the SAME reservation and writes exactly one row', async () => {
    const key = 'unit:budget:same';
    const input: ReserveBudgetInput = {
      userId: DEMO_USER_ID,
      name: '旅行预留',
      amount: '800.00',
      purpose: '旅行',
      idempotencyKey: key,
    };

    const first = await banking.budget.reserveBudget(input);
    const second = await banking.budget.reserveBudget(input);

    expect(second.id).toBe(first.id);
    expect(second.amount).toBe('800.00');
    expect(second.purpose).toBe('旅行');
    expect(await db().budget.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('absent idempotencyKey creates independent reservations', async () => {
    const before = await db().budget.count({ where: { userId: DEMO_USER_ID } });
    const input: ReserveBudgetInput = { userId: DEMO_USER_ID, name: '无键预留', amount: '100.00' };

    const first = await banking.budget.reserveBudget(input);
    const second = await banking.budget.reserveBudget(input);

    expect(second.id).not.toBe(first.id);
    expect(await db().budget.count({ where: { userId: DEMO_USER_ID } })).toBe(before + 2);
  });

  it('a whitespace-only key is treated as absent: two calls create two rows', async () => {
    const input: ReserveBudgetInput = {
      userId: DEMO_USER_ID,
      name: '空白键预留',
      amount: '100.00',
      idempotencyKey: '   ',
    };

    const first = await banking.budget.reserveBudget(input);
    const second = await banking.budget.reserveBudget(input);

    expect(second.id).not.toBe(first.id);
    expect(
      await db().budget.count({ where: { userId: DEMO_USER_ID, idempotencyKey: null } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('two DIFFERENT keys create two rows', async () => {
    const k1 = 'unit:budget:diff:1';
    const k2 = 'unit:budget:diff:2';

    const first = await banking.budget.reserveBudget({
      userId: DEMO_USER_ID,
      name: '预算甲',
      amount: '100.00',
      idempotencyKey: k1,
    });
    const second = await banking.budget.reserveBudget({
      userId: DEMO_USER_ID,
      name: '预算乙',
      amount: '100.00',
      idempotencyKey: k2,
    });

    expect(second.id).not.toBe(first.id);
    expect(await db().budget.count({ where: { idempotencyKey: { in: [k1, k2] } } })).toBe(2);
  });
});

/* ----------------------------------------------------------- createScheduledTask */

describe('banking-sdk · idempotent: createScheduledTask', () => {
  it('same idempotencyKey twice returns the SAME task and writes exactly one row', async () => {
    const key = 'unit:task:same';
    const input: CreateScheduledTaskInput = {
      userId: DEMO_USER_ID,
      name: '缴房租提醒',
      kind: 'REMINDER',
      payload: { note: '房租' },
      runAt: RUN_AT,
      idempotencyKey: key,
    };

    const first = await banking.task.createScheduledTask(input);
    const second = await banking.task.createScheduledTask(input);

    expect(second.id).toBe(first.id);
    expect(second.runAt).toBe(RUN_AT);
    expect(second.kind).toBe('REMINDER');
    expect(await db().scheduledTask.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('absent idempotencyKey creates independent scheduled tasks', async () => {
    const before = await db().scheduledTask.count({ where: { userId: DEMO_USER_ID } });
    const input: CreateScheduledTaskInput = {
      userId: DEMO_USER_ID,
      name: '无键任务',
      kind: 'PAYMENT',
      runAt: RUN_AT,
    };

    const first = await banking.task.createScheduledTask(input);
    const second = await banking.task.createScheduledTask(input);

    expect(second.id).not.toBe(first.id);
    expect(await db().scheduledTask.count({ where: { userId: DEMO_USER_ID } })).toBe(before + 2);
  });

  it('a whitespace-only key is treated as absent: two calls create two rows', async () => {
    const input: CreateScheduledTaskInput = {
      userId: DEMO_USER_ID,
      name: '空白键任务',
      kind: 'TRANSFER',
      runAt: RUN_AT,
      idempotencyKey: '',
    };

    const first = await banking.task.createScheduledTask(input);
    const second = await banking.task.createScheduledTask(input);

    expect(second.id).not.toBe(first.id);
    expect(
      await db().scheduledTask.count({ where: { userId: DEMO_USER_ID, idempotencyKey: null } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('two DIFFERENT keys create two rows', async () => {
    const k1 = 'unit:task:diff:1';
    const k2 = 'unit:task:diff:2';

    const first = await banking.task.createScheduledTask({
      userId: DEMO_USER_ID,
      name: '任务甲',
      kind: 'REMINDER',
      runAt: RUN_AT,
      idempotencyKey: k1,
    });
    const second = await banking.task.createScheduledTask({
      userId: DEMO_USER_ID,
      name: '任务乙',
      kind: 'REMINDER',
      runAt: RUN_AT,
      idempotencyKey: k2,
    });

    expect(second.id).not.toBe(first.id);
    expect(await db().scheduledTask.count({ where: { idempotencyKey: { in: [k1, k2] } } })).toBe(2);
  });
});
