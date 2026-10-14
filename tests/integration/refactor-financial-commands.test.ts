import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '@/agent/tools';
import { getOrCreateSession } from '@/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { SPENDING_CATEGORIES } from '@/banking-sdk/categories';
import { AppError } from '@/lib/errors';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

useFreshDatabase();
const category = SPENDING_CATEGORIES[3];
const registry = () => createToolRegistry(DEMO_USER_ID);
const database = () => getTestPrisma();

const commands: Array<{ name: ToolName; args: Record<string, unknown> }> = [
  { name: 'set_card_limit', args: { cardId: 'card_credit', category, amount: '1250.25' } },
  { name: 'cancel_subscription', args: { subscriptionId: 'sub_netflix' } },
  { name: 'subscribe_investment', args: { productId: 'prod_wenjiana', amount: '1000.25' } },
];

async function financialSnapshot() {
  const client = database();
  return Promise.all([
    client.account.findMany({ orderBy: { id: 'asc' } }),
    client.cardLimit.findMany({ orderBy: { id: 'asc' } }),
    client.subscription.findMany({ orderBy: { id: 'asc' } }),
    client.investmentHolding.findMany({ orderBy: { id: 'asc' } }),
    client.transaction.findMany({ orderBy: { id: 'asc' } }),
  ]);
}

describe('uniform financial command commit boundary', () => {
  it('commits card, subscription and investment changes with one original receipt and audit each', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const tools = registry();
    for (const command of commands) {
      const key = `financial-commit:${command.name}`;
      const result = await tools.executeDirect(command.name, command.args, { sessionId, idempotencyKey: key });
      expect(result.ok).toBe(true);
      const receipt = await database().executionReceipt.findUniqueOrThrow({ where: { userId_key: { userId: DEMO_USER_ID, key } } });
      expect(receipt.commandDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(receipt.responseJson!)).toEqual(result);
      expect(await database().auditLog.count({ where: { sessionId, toolName: command.name, status: 'success' } })).toBe(1);
    }
    expect((await database().cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category } })).amountMinor).toBe(125_025n);
    expect((await database().subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).status).toBe('CANCELLED');
    expect((await database().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2_257_975n);
    expect(await database().investmentHolding.count({ where: { userId: DEMO_USER_ID, principalAmountMinor: 100_025n } })).toBe(1);
    expect(await database().executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(3);
  });

  it('rolls back every non-transfer write, ledger and receipt when the required audit fails', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const before = await financialSnapshot();
    for (const command of commands) {
      await expect(registry().executeDirect(command.name, command.args, {
        sessionId, idempotencyKey: `financial-audit-failure:${command.name}`,
        onCommandCommit: async () => { throw new AppError('INTERNAL', 'Required execution audit failed.'); },
      })).resolves.toMatchObject({ ok: false, errorCode: 'INTERNAL' });
      expect(await financialSnapshot()).toEqual(before);
      expect(await database().executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(0);
      expect(await database().auditLog.count({ where: { sessionId } })).toBe(0);
    }
  });

  it('rejects changed arguments and changed tools under an already committed identity', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const tools = registry();
    const options = { sessionId, idempotencyKey: 'financial-conflict:shared' };
    expect((await tools.executeDirect('set_card_limit', commands[0].args, options)).ok).toBe(true);
    await expect(tools.executeDirect('set_card_limit', { ...commands[0].args, amount: '1250.26' }, options))
      .resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    await expect(tools.executeDirect('cancel_subscription', commands[1].args, options))
      .resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    expect((await database().cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category } })).amountMinor).toBe(125_025n);
    expect((await database().subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).status).toBe('ACTIVE');
    expect(await database().executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
    expect(await database().auditLog.count({ where: { sessionId } })).toBe(1);
  });

  it('replays the complete original response without overwriting a later mutable card limit', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const tools = registry();
    const options = { sessionId, idempotencyKey: 'financial-replay:original' };
    const original = await tools.executeDirect('set_card_limit', commands[0].args, options);
    await database().cardLimit.updateMany({ where: { cardId: 'card_credit', category }, data: { amountMinor: 77_777n } });
    expect(await tools.executeDirect('set_card_limit', commands[0].args, options)).toEqual(original);
    expect((await database().cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category } })).amountMinor).toBe(77_777n);
    expect(await database().auditLog.count({ where: { sessionId } })).toBe(1);
    expect(await database().executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
  });

  it.each(['commandDigest', 'responseJson'] as const)('rejects missing current %s without reapplying the committed command', async field => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    const tools = registry();
    const options = { sessionId, idempotencyKey: 'financial-corrupt:original' };
    expect((await tools.executeDirect('set_card_limit', commands[0].args, options)).ok).toBe(true);
    await database().cardLimit.updateMany({ where: { cardId: 'card_credit', category }, data: { amountMinor: 77_777n } });
    await database().executionReceipt.update({
      where: { userId_key: { userId: DEMO_USER_ID, key: options.idempotencyKey } }, data: { [field]: null },
    });
    await expect(tools.executeDirect('set_card_limit', commands[0].args, options))
      .resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    expect((await database().cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category } })).amountMinor).toBe(77_777n);
    expect(await database().auditLog.count({ where: { sessionId } })).toBe(1);
  });

  it('preserves large decimal-string purchases and rejects fractional cents before another posting', async () => {
    const { sessionId } = await getOrCreateSession(DEMO_USER_ID);
    await database().account.update({ where: { id: 'acct_checking' }, data: { balanceMinor: 9_007_199_254_740_994n } });
    const result = await registry().executeDirect('subscribe_investment', {
      productId: 'prod_wenjiana', amount: '90071992547409.93',
    }, { sessionId, idempotencyKey: 'financial-precision:large' });
    expect(result).toMatchObject({ ok: true, data: { amount: '90071992547409.93', newBalance: '0.01' } });
    const before = await financialSnapshot();
    const refused = await registry().executeDirect('subscribe_investment', {
      productId: 'prod_wenjiana', amount: '1000.005',
    }, { sessionId, idempotencyKey: 'financial-precision:fractional' });
    expect(refused.ok).toBe(false);
    expect(await financialSnapshot()).toEqual(before);
    expect(await database().executionReceipt.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
  });
});
