// Read-only diagnostic: dump the investment-related chat cards of the last live run's session.
import path from 'node:path';
import fs from 'node:fs';

const root = process.cwd();
process.env['DATABASE_URL'] = `file:${path.join(root, 'prisma', 'live-acceptance.db').split(path.sep).join('/')}`;

async function main(): Promise<void> {
  const { dbClient } = await import('../lib/db/client');
  const db = dbClient();
  const sessions = await db.agentSession.findMany();
  const out: string[] = [`sessions=${sessions.length}`];
  for (const session of sessions) {
    const state = session.stateJson as unknown;
    out.push(`--- session ${session.id} keys=${state && typeof state === 'object' ? Object.keys(state as object).join(',') : typeof state}`);
  }
  const receipts = await db.executionReceipt.findMany({ where: { toolName: { in: ['subscribe_investment', 'redeem_investment'] } } });
  for (const receipt of receipts) {
    const response = receipt.responseJson ?? '';
    out.push(`=== receipt ${receipt.key} tool=${receipt.toolName} hasHoldings=${response.includes('"holdings"')} hasSharesSeed=${response.includes('4999.864825')} hasSharesNew=${response.includes('5965.395384')} len=${response.length}`);
    out.push(response.slice(0, 1200));
  }
  fs.writeFileSync(path.join(root, 'logs', 'lB-r2.cards.log'), out.join('\n') + '\n', 'utf8');
}

void main().then(() => process.exit(0)).catch((error: unknown) => {
  fs.writeFileSync(path.join(process.cwd(), 'logs', 'lB-r2.cards.log'), `ERROR ${String(error)}\n${(error as Error)?.stack ?? ''}`, 'utf8');
  process.exit(1);
});
