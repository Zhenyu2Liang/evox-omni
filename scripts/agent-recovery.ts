import nextEnv from '@next/env';
import { pathToFileURL } from 'node:url';

export interface RecoveryCliOptions {
  once: boolean;
  intervalMs: number;
  limit: number;
}

/** CLI flags control scheduling only; run identity and recovery policy come from persistence. */
export function parseRecoveryArguments(args: readonly string[]): RecoveryCliOptions {
  const result: RecoveryCliOptions = { once: false, intervalMs: 5000, limit: 25 };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--once') { result.once = true; continue; }
    if (flag !== '--interval-ms' && flag !== '--limit') throw new Error(`Unsupported recovery worker argument: ${flag}`);
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value)) throw new Error(`${flag} requires an integer value.`);
    if (flag === '--interval-ms') result.intervalMs = value;
    else result.limit = value;
  }
  if (result.limit < 1 || result.limit > 100) throw new Error('Recovery batch limit must be from 1 through 100.');
  if (result.intervalMs < 250 || result.intervalMs > 60000) throw new Error('Recovery interval must be from 250 through 60000 milliseconds.');
  return result;
}

export async function runRecoveryCommand(args = process.argv.slice(2)): Promise<void> {
  const options = parseRecoveryArguments(args);
  nextEnv.loadEnvConfig(process.cwd(), false, {
    info: () => undefined,
    error: () => { throw new Error('Environment configuration could not be loaded.'); },
  });
  const [{ prisma }, { tickAgentRecovery, runAgentRecoveryWorker }] = await Promise.all([
    import('../lib/db/client'), import('../agent/recovery-worker'),
  ]);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const onTick = (result: unknown) => { process.stdout.write(`${JSON.stringify(result)}\n`); };
    if (options.once) onTick(await tickAgentRecovery({ ...options, signal: shutdown.signal }));
    else await runAgentRecoveryWorker({ ...options, signal: shutdown.signal, onTick });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRecoveryCommand().catch(() => {
    process.stderr.write('Agent recovery worker failed. Inspect the persisted run metadata and server diagnostics.\n');
    process.exitCode = 1;
  });
}
