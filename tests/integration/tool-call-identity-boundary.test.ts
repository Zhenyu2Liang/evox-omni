import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runTurn } from '@/agent';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';

useFreshDatabase();
const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'user_liming' };

describe('provider tool call identities at the actual banking hooks', () => {
  it('refuses an ambiguous metadata and banking batch before authorization or budget effects', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['reserve_budget'] }, [
      fauxAssistantMessage([
        fauxToolCall('describe_turn', { purpose: 'operation', operations: ['reserve_budget'] }, { id: 'duplicate' }),
        fauxToolCall('reserve_budget', { name: 'Shopping', amount: '10.00' }, { id: 'duplicate' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage('The proposed call identities were ambiguous. No operation was performed.'),
    ]);
    const db = getTestPrisma();
    const beforeReservations = await db.budget.count();
    const beforeBalance = (await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    const response = await runTurn({ message: 'Prepare a shopping budget of 10.00.' }, { config, provider: script.provider });
    expect(response.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    expect(await db.pendingAction.count()).toBe(0);
    expect(await db.executionReceipt.count()).toBe(0);
    expect(await db.budget.count()).toBe(beforeReservations);
    expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(beforeBalance);
    const calls = await db.toolInvocation.findMany({ where: { callId: 'duplicate' } });
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.status === 'failed')).toBe(true);
    expect(calls.every(call => call.errorCode === 'VALIDATION')).toBe(true);
  });
});
