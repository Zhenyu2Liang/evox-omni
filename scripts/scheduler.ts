import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

/** A bounded server-side tick; repeated invocations are safe and never approve bank commands. */
async function main(): Promise<void> {
  const { prisma } = await import('../lib/db/client');
  const { tickScheduledTasks } = await import('../agent/scheduled-dispatcher');
  const { demoNow } = await import('../lib/clock');
  try {
    const index = process.argv.indexOf('--now');
    const now = index >= 0 ? Date.parse(process.argv[index + 1] ?? '') : demoNow();
    if (!Number.isFinite(now)) throw new Error('Expected --now followed by an ISO timestamp.');
    const schedules = await prisma.scheduledTask.findMany({
      where: {
        sessionId: { not: null }, runAt: { lte: new Date(now) },
        status: { in: ['SCHEDULED', 'DISPATCHING'] },
      },
      select: { userId: true, sessionId: true },
      distinct: ['userId', 'sessionId'],
    });
    for (const schedule of schedules) {
      if (!schedule.sessionId) continue;
      const result = await tickScheduledTasks({ userId: schedule.userId, sessionId: schedule.sessionId }, { now });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Scheduler failed.'}\n`);
  process.exitCode = 1;
});
