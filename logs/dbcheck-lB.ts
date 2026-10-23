// Read-only DB verification for live scenario lB (investment partial redemption).
// Usage: pnpm exec tsx logs/dbcheck-lB.ts <round>
import path from 'node:path';
import fs from 'node:fs';

const root = process.cwd();
process.env['DATABASE_URL'] = `file:${path.join(root, 'prisma', 'live-acceptance.db').split(path.sep).join('/')}`;

const round = process.argv[2] ?? 'x';
const outFile = path.join(root, 'logs', `lB-r${round}.dbcheck.log`);

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function main(): Promise<void> {
  const { dbClient } = await import('../lib/db/client');
  const db = dbClient();

  const holding = await db.investmentHolding.findUnique({
    where: { id: 'holding_wenjiana' },
    select: {
      id: true,
      shares: true,
      principalAmountMinor: true,
      realizedProfitMinor: true,
      estimatedMarketValue: true,
      status: true,
    },
  });
  const account = await db.account.findUnique({
    where: { id: 'acct_checking' },
    select: { id: true, balanceMinor: true },
  });
  const investmentTxs = await db.transaction.findMany({
    where: { category: '投资' },
    select: { id: true, amountMinor: true, direction: true, merchant: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const allTx = await db.transaction.count();
  const auditLogs = await db.auditLog.findMany({
    where: { toolName: { in: ['subscribe_investment', 'redeem_investment'] } },
    select: { id: true, toolName: true, status: true, timestamp: true, detail: true },
    orderBy: { timestamp: 'asc' },
  });
  const receipts = await db.executionReceipt.findMany({
    where: { toolName: { in: ['subscribe_investment', 'redeem_investment'] } },
    select: { key: true, toolName: true, responseJson: true },
    orderBy: { createdAt: 'asc' },
  });
  const pending = await db.pendingAction.findMany({
    where: { toolName: { in: ['subscribe_investment', 'redeem_investment'] } },
    select: { id: true, toolName: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  const product = await db.investmentProduct.findFirst({
    where: { holdings: { some: { id: 'holding_wenjiana' } } },
    select: {
      id: true,
      name: true,
      latestNetValuePerUnit: true,
      latestNetValueDate: true,
      annualYieldRate: true,
    },
  });

  const report = {
    round,
    database: 'prisma/live-acceptance.db',
    holding,
    account,
    product,
    investmentTransactions: investmentTxs,
    transactionCountTotal: allTx,
    auditLogs: auditLogs.map((row) => ({
      id: row.id,
      toolName: row.toolName,
      status: row.status,
      detail: row.detail ? row.detail.slice(0, 400) : null,
    })),
    receipts: receipts.map((row) => {
      const response = row.responseJson ?? '';
      return {
        key: row.key,
        toolName: row.toolName,
        responseLength: response.length,
        hasHoldings: response.includes('"holdings"'),
        sharesMentions: Array.from(new Set(response.match(/"shares":"[0-9.]+"/g) ?? [])),
      };
    }),
    pendingActions: pending,
  };

  fs.writeFileSync(outFile, `${JSON.stringify(report, replacer, 2)}\nDBCHECK_EXITCODE=0\n`, 'utf8');
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    fs.writeFileSync(
      outFile,
      `ERROR ${String(error)}\n${(error as Error)?.stack ?? ''}\nDBCHECK_EXITCODE=1\n`,
      'utf8',
    );
    process.exit(1);
  });
