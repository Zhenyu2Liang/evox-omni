import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from '@earendil-works/pi-ai';
import { runTurn } from '@/agent';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';

useFreshDatabase();
const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'user_liming' };

describe('direct banking calls retain explicit input types', () => {
  it.each<{ name: string; args: JsonObject }>([
    { name: 'transfer_money', args: { contactId: 'contact_zhangwei', amount: 1.05 } },
    { name: 'transfer_money', args: { contactId: 'contact_zhangwei', amount: '200.00', sourceAccountName: 'Savings' } },
    { name: 'set_subscription_reminder', args: { subscriptionId: 'sub_netflix', enabled: 'false' } },
  ])('refuses implicit conversion or unregistered parameters for $name', async ({ name, args }) => {
    const db = getTestPrisma();
    const transactionsBefore = await db.transaction.findMany({ orderBy: { id: 'asc' } });
    const subscriptionsBefore = await db.subscription.findMany({ orderBy: { id: 'asc' } });
    const script = scriptedProvider({ purpose: 'operation', operations: [name] }, [
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Please provide explicit parameters matching this operation.'),
    ]);
    const response = await runTurn({ message: 'Prepare the requested operation.' }, { config, provider: script.provider });
    expect(response.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    expect(await db.pendingAction.count()).toBe(0);
    expect(await db.executionReceipt.count()).toBe(0);
    expect(await db.agentTask.count()).toBe(0);
    expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    expect(await db.transaction.findMany({ orderBy: { id: 'asc' } })).toEqual(transactionsBefore);
    expect(await db.subscription.findMany({ orderBy: { id: 'asc' } })).toEqual(subscriptionsBefore);
    expect(response.events.filter(event => event.type === 'tool_end').map(event => event.toolEvent)).toContainEqual(
      expect.objectContaining({ toolName: name, status: 'blocked', summary: 'chat.error.parametersNotSubmitted' }),
    );
  });
});
