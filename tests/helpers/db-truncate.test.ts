/**
 * tests/helpers/db-truncate.test.ts — guards `truncateAll()`'s COMPLETENESS.
 *
 * `truncateAll()` must delete from EVERY model of `prisma/schema.prisma`. A declared
 * `onDelete: Cascade` is not a substitute: an omitted table silently leaks rows (and UNIQUE
 * replay identities) from one test — and from one RUN of the same file — into the next.
 * `CardConsumption` is the cautionary case: relation-free (only indexes + a UNIQUE
 * `executionKey`), it survived `resetDatabase()`, so a repeat run replayed against a previous
 * run's card id and threw `CONFLICT`. Suites worked around it with an extra `beforeEach`.
 *
 * THREE layers, so a NEW model cannot be forgotten either:
 *   1. STRUCTURAL — every `model` in the schema has a `<delegate>.deleteMany(` call in `db.ts`.
 *   2. BEHAVIOURAL — residue rows in the previously-missed tables are really gone afterwards,
 *      and the whole database reports zero rows across every delegate.
 *   3. REGRESSION — a `CardConsumption` row with a fixed `executionKey` does not survive
 *      `resetDatabase()`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { PrismaClient } from '@/lib/db/prisma';
import { demoNow } from '@/lib/clock';
import { getTestPrisma, resetDatabase, truncateAll, useFreshDatabase } from './db';
import { DEMO_USER_ID } from './fixtures';

useFreshDatabase();

const prisma = () => getTestPrisma();

/** Delegate names exposed by the client (`user`, `cardConsumption`, …) — the units `truncateAll()` clears. */
function modelDelegates(client: PrismaClient): string[] {
  const record = client as unknown as Record<string, unknown>;
  return Object.keys(record).filter((key) => {
    if (key.startsWith('$') || key.startsWith('_')) return false;
    const value = record[key] as { count?: unknown } | null | undefined;
    return typeof value?.count === 'function';
  });
}

/** Row count per delegate, in one pass — the "is the database really empty?" probe. */
async function countEveryModel(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of modelDelegates(prisma())) {
    const delegate = (prisma() as unknown as Record<string, { count: () => Promise<number> }>)[name];
    counts[name] = await delegate.count();
  }
  return counts;
}

/** `prisma/schema.prisma` model names mapped to their camelCase client delegate. */
function schemaDelegates(): string[] {
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  const names = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
  return names.map((name) => name[0].toLowerCase() + name.slice(1));
}

/** The `truncateAll()` source text — the list being policed. */
function truncateAllSource(): string {
  return readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
}

describe('truncateAll() completeness', () => {
  it('deletes from every model declared in prisma/schema.prisma', () => {
    const delegates = schemaDelegates();
    const source = truncateAllSource();
    // Sanity: the schema really was parsed (a broken regex must not make this a no-op pass).
    expect(delegates.length).toBeGreaterThan(20);
    expect(delegates).toContain('cardConsumption');

    const missing = delegates.filter((delegate) => !source.includes(`prisma.${delegate}.deleteMany(`));
    expect(missing, `truncateAll() must clear these models: ${missing.join(', ')}`).toEqual([]);
  });

  it('only names real client delegates (no stale table in the truncation list)', () => {
    const known = new Set(modelDelegates(prisma()));
    const listed = [...truncateAllSource().matchAll(/prisma\.(\w+)\.deleteMany\(/g)].map((match) => match[1]);
    expect(listed.length).toBeGreaterThan(20);
    expect(listed.filter((delegate) => !known.has(delegate))).toEqual([]);
  });

  it('really empties the relation-free and cascade-only tables, and the whole database', async () => {
    // Residue in the tables `truncateAll()` used to omit: one relation-free ledger row and two
    // child rows whose parent is deleted anyway (so `onDelete: Cascade` could hide the omission).
    await prisma().cardConsumption.create({ data: {
      id: 'cc_residue',
      cardId: 'card_debit',
      accountId: 'acct_checking',
      userId: DEMO_USER_ID,
      amountMinor: 100n,
      category: '购物',
      merchant: '残留商户',
      occurredAt: new Date(demoNow()),
      executionKey: 'residue:execution:key',
      resultJson: '{"consumption":{"id":"cc_residue"}}',
    } });
    const run = await prisma().agentRun.create({ data: {
      id: 'run_residue',
      sessionId: 'sess_residue',
      userId: DEMO_USER_ID,
      requestDigest: 'digest_residue',
      requestJson: '{}',
    } });
    await prisma().modelRequest.create({ data: {
      id: 'mr_residue',
      runId: run.id,
      ordinal: 1,
      requestDigest: 'digest_residue',
      inputJson: '{}',
    } });
    const task = await prisma().scheduledTask.create({ data: {
      id: 'sched_residue',
      userId: DEMO_USER_ID,
      name: '残留提醒',
      kind: 'REMINDER',
      runAt: new Date(demoNow()),
      payload: '{}',
    } });
    await prisma().scheduledNotification.create({ data: {
      id: 'sn_residue',
      scheduledTaskId: task.id,
      userId: DEMO_USER_ID,
      sessionId: 'sess_residue',
      message: '残留提醒已送达',
    } });

    await truncateAll();

    expect(await prisma().cardConsumption.count()).toBe(0);
    expect(await prisma().modelRequest.count()).toBe(0);
    expect(await prisma().scheduledNotification.count()).toBe(0);
    expect(await countEveryModel()).toEqual(Object.fromEntries(modelDelegates(prisma()).map((name) => [name, 0])));
  });

  it('a CardConsumption row (with its UNIQUE executionKey) never survives resetDatabase()', async () => {
    await prisma().cardConsumption.create({ data: {
      id: 'cc_leak',
      cardId: 'card_debit',
      accountId: 'acct_checking',
      userId: DEMO_USER_ID,
      amountMinor: 250n,
      category: '出行',
      merchant: '泄漏商户',
      occurredAt: new Date(demoNow()),
      executionKey: 'leak:execution:key',
    } });

    await resetDatabase();

    // The re-seeded world has NO spend history: a leftover row would (a) feed the card family's
    // monthly spend and (b) make this `executionKey` replay against the OLD card id ⇒ CONFLICT.
    expect(await prisma().cardConsumption.count()).toBe(0);
    expect(await prisma().cardConsumption.findUnique({ where: { executionKey: 'leak:execution:key' } })).toBeNull();
  });
});
