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
    const script = scriptedProvider({ purpose: 'operation', operations: [name] }, [
      fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Please provide explicit parameters matching this operation.'),
    ]);
    const response = await runTurn({ message: 'Prepare the requested operation.' }, { config, provider: script.provider });
    const db = getTestPrisma();
    expect(response.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    expect(await db.pendingAction.count()).toBe(0);
    expect(await db.executionReceipt.count()).toBe(0);
    expect(await db.agentTask.count()).toBe(0);
    expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.status === 'error')).toBe(true);
  });
});
