import { beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { runTurn, confirmAction, loadSession } from '@/agent';
import { readAuthorizationToolContext } from '@/agent/authorization-context';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { AppConfig } from '@/lib/config';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import fixtures from '../fixtures/authorization-resume.zh-CN.json';
import { turnDeclaration } from '@/tests/helpers/scripted-provider';

const config: AppConfig = { llmMode: 'live', llmProvider: 'deepseek', llmModel: 'deepseek-flash', demoUserId: 'user_liming' };
beforeEach(resetDatabase);

function resultFor(messages: readonly AgentMessage[], amount: string): ToolResultMessage | undefined {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.content.some(block => block.type === 'toolCall' &&
      block.name === 'transfer_money' && block.arguments.amount === amount)) continue;
    const next = messages.slice(index + 1).find(item => item.role === 'toolResult' && item.toolName === 'transfer_money');
    if (next?.role === 'toolResult') return next;
  }
  return undefined;
}

describe('authorization result provider ownership', () => {
  it('updates the original write only when a later pending write reused the provider call ID and tool name', async () => {
    const faux = fauxProvider();
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses(['200.00', '300.00'].map(amount => fauxAssistantMessage([
      ...turnDeclaration({ purpose: 'operation', operations: ['transfer_money'] }).content,
      fauxToolCall('transfer_money', { contactId: 'contact_zhangwei', amount }, { id: 'reused-write' }),
    ], { stopReason: 'toolUse', timestamp: 10 })));
    let modelCalls = 0;
    const provider = { model: faux.getModel(), streamFn: (...args: Parameters<typeof models.streamSimple>) => {
      modelCalls++; return models.streamSimple(...args);
    } };
    const first = await runTurn({ message: fixtures.delayedTransfer }, { config, provider });
    const firstDecision = first.events.find(event => event.type === 'confirmation_required');
    if (firstDecision?.type !== 'confirmation_required') throw new Error('The original transfer authorization is missing.');
    const second = await runTurn({ sessionId: first.sessionId, message: fixtures.repeatedTransfer }, { config, provider });
    const secondDecision = second.events.find(event => event.type === 'confirmation_required');
    if (secondDecision?.type !== 'confirmation_required') throw new Error('The second transfer authorization is missing.');
    const before = (await loadSession(first.sessionId))!;
    const newerResult = resultFor(before.agentState.messages, '300.00');
    expect(newerResult?.isError).toBe(true);
    const original = await readAuthorizationToolContext({ sessionId: first.sessionId, actionId: firstDecision.actionId,
      toolName: 'transfer_money', toolResult: { ok: true } }, before, before.agentState.messages);
    expect(original?.call?.arguments.amount).toBe('200.00');
    const db = getTestPrisma();
    const [oldDebitCount, newerDebitCount, checking] = await Promise.all([
      db.transaction.count({ where: { userId: config.demoUserId, direction: 'DEBIT', amountMinor: -20000n } }),
      db.transaction.count({ where: { userId: config.demoUserId, direction: 'DEBIT', amountMinor: -30000n } }),
      db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } }),
    ]);
    const outcome = await confirmAction(firstDecision.actionId, { sessionId: first.sessionId, userId: config.demoUserId, deps: { config, provider } });
    expect(outcome.status).toBe('executed');
    expect(outcome.events.some(event => event.type === 'error')).toBe(false);
    expect(modelCalls).toBe(2);
    const after = (await loadSession(first.sessionId))!;
    expect(resultFor(after.agentState.messages, '200.00')?.isError).toBe(false);
    expect(resultFor(after.agentState.messages, '300.00')).toEqual(newerResult);
    expect(after.transcript.map(message => message.id).slice(0, before.transcript.length))
      .toEqual(before.transcript.map(message => message.id));
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: secondDecision.actionId } })).status).toBe('pending');
    expect(await db.transaction.count({ where: { userId: config.demoUserId, direction: 'DEBIT', amountMinor: -20000n } })).toBe(oldDebitCount + 1);
    expect(await db.transaction.count({ where: { userId: config.demoUserId, direction: 'DEBIT', amountMinor: -30000n } })).toBe(newerDebitCount);
    expect((await db.account.findUniqueOrThrow({ where: { id: checking.id } })).balanceMinor).toBe(checking.balanceMinor - 20000n);
    expect(await db.auditLog.count({ where: { sessionId: first.sessionId, toolName: 'transfer_money', status: 'success' } })).toBe(1);
  });
});
