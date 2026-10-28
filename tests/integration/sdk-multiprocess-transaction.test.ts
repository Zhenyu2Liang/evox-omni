import { fork } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';

useFreshDatabase();
it.each(['same', 'overdraft', 'category'])('serializes SDK %s races across independent processes', async mode => {
  const db = getTestPrisma();
  await db.account.update({ where: { id: 'acct_checking' }, data: { balanceMinor: 10000n } });
  if (mode === 'category') await banking.card.setCardLimit({ userId: 'user_liming', cardId: 'card_debit', category: '餐饮', amount: '100.00' });
  const before = await db.transaction.count();
  const workers = Array.from({ length: 4 }, (_, index) => {
    const child = fork(path.resolve('tests/helpers/sdk-race-worker.ts'), [], {
      execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env,
    });
    let ready!: () => void;
    let done!: (result: { ok: boolean; code?: string; result?: unknown }) => void;
    let failed!: (error: Error) => void;
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const resultPromise = new Promise<{ ok: boolean; code?: string; result?: unknown }>((resolve, reject) => { done = resolve; failed = reject; });
    const exit = new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
    child.on('message', (message: { ready?: boolean; done?: boolean; ok: boolean; code?: string }) => {
      if (message.ready) ready();
      if (message.done) done(message);
    });
    child.on('error', failed);
    return { child, ready: readyPromise, result: resultPromise, exit, index };
  });
  try {
    await Promise.all(workers.map(worker => worker.ready));
    for (const worker of workers) worker.child.send({ mode, index: worker.index });
    const results = await Promise.all(workers.map(worker => worker.result));
    await Promise.all(workers.map(worker => worker.exit));
    expect(await db.transaction.count()).toBe(before + 1);
    expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(4000n);
    if (mode === 'same') {
      expect(results.every(result => result.ok)).toBe(true);
      expect(new Set(results.map(result => JSON.stringify(result.result))).size).toBe(1);
    } else {
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok).map(result => result.code))
        .toEqual(Array(3).fill(mode === 'category' ? 'LIMIT_EXCEEDED' : 'INSUFFICIENT_FUNDS'));
    }
  } finally { for (const { child } of workers) if (child.connected) child.kill(); }
}, 45000);
