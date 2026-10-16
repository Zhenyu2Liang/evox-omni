/**
 * Regression coverage for the LIVE-mode "fabricated confirmation panel" defect against REAL server
 * records (gateway, `PendingAction`/`ToolInvocation`, ledger balances, durable runs).
 *
 * A confirmation/MFA panel exists ONLY while a real `PendingAction` row does. When a turn DECLARES a
 * banking write (`describe_turn`) but never emits a controlled tool call, the runtime may spend at
 * most ONE bounded continuation (`agent/write-continuation.ts`); if the write still stays unsubmitted,
 * the server — never the model — narrates the true outcome. Model prose can therefore never assert a
 * panel, a waiting state or a completed operation that no record backs.
 *
 * The colocated `agent/write-continuation.test.ts` covers the three reply shapes at the unit level.
 * These tests go deeper: they verify the policy against a real gateway gate, a real executed transfer
 * and the durable recovery path, and they assert the fabricated claim never reaches the transcript.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall,
  type FauxResponseStep, type ToolCall,
} from '@earendil-works/pi-ai';
import { confirmAction, loadSession, runTurn, type ModelRuntime } from '@/agent';
import { AgentRunJournal, beginRun } from '@/agent/durable';
import { continueDurableRun } from '@/agent/durable/continuation';
import { encodeCheckpoint } from '@/agent/durable/checkpoint';
import { runtimeRequestDigest } from '@/agent/durable/serialization';
import { getOrCreateSession } from '@/agent/session';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import { completeModelRequest, startModelRequest } from '@/lib/db/repositories/agentRun';
import type { AppConfig } from '@/lib/config';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const config: AppConfig = { llmMode: 'live', llmProvider: 'deepseek', llmModel: 'scripted', demoUserId: DEMO_USER_ID };
/** Seeded 活期 balance (`tests/helpers/fixtures.ts` ACCOUNTS: 23580.00). */
const SEEDED_CHECKING_BALANCE = 2358000n;
const TRANSFER_TO_ZHANGWEI = '给张伟转账200.37元';
/** The server-authored state published when a declared write stayed unsubmitted — never model prose. */
const DECLARED_TRANSFER_UNSUBMITTED =
  '本轮声明要办理：转账。系统未记录到该操作的提交结果或确认入口，操作尚未提交。请核对并补充完整信息后重新发送；如已有操作卡，请通过卡片继续处理。';

const toolCall = (name: string, args: ToolCall['arguments'] = {}): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

/**
 * The durable tests carry their declaration inside the run checkpoint (declaration first, then the
 * candidate reply), so this provider only supplies recovery continuations — no `describe_turn` step.
 */
function rawProvider(steps: FauxResponseStep[]): { provider: ModelRuntime; calls(): number } {
  const registration = fauxProvider();
  const models = createModels();
  models.setProvider(registration.provider);
  registration.setResponses(steps);
  return { provider: { model: registration.getModel(), streamFn: models.streamSimple.bind(models) },
    calls: () => registration.state.callCount };
}

function hasGate(response: Pick<ChatTurnResponse, 'events'>): boolean {
  return response.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required');
}

function finalContent(response: Pick<ChatTurnResponse, 'events'>): string {
  return response.events.flatMap(event => event.type === 'message_end' && event.message.role === 'assistant'
    ? [event.message.content] : []).filter(Boolean).at(-1) ?? '';
}

const checkingBalance = async (): Promise<bigint> =>
  (await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;

const transcriptOf = async (sessionId: string) => (await loadSession(sessionId))?.transcript ?? [];

/** Persisted assistant text a user could actually have seen, from the UI-event channel. */
async function durableUiText(runId: string): Promise<string> {
  const events = await getTestPrisma().agentRunEvent.findMany({ where: { runId, channel: 'ui' }, orderBy: { sequence: 'asc' } });
  return events.filter(event => event.eventType === 'text_delta')
    .map(event => (JSON.parse(event.payloadJson) as { delta: string }).delta).join('');
}

async function durableUiEventTypes(runId: string): Promise<string[]> {
  const events = await getTestPrisma().agentRunEvent.findMany({ where: { runId, channel: 'ui' }, orderBy: { sequence: 'asc' } });
  return events.map(event => event.eventType);
}

/** Admit a run whose declaration lives in the checkpoint and whose latest completed model reply is prose. */
async function admittedDeclaredWriteRun(requestId: string, candidate: string) {
  const message = TRANSFER_TO_ZHANGWEI;
  const snapshot = await getOrCreateSession(config.demoUserId);
  snapshot.intent = declareConversationIntent(advanceConversationIntent(undefined, message), 'operation', ['transfer_money']);
  // The declaration only survives into the rebuilt runtime while the originating user message does.
  snapshot.agentState.messages = [{ role: 'user', content: message, timestamp: 1 }];
  const checkpoint = encodeCheckpoint(snapshot, config);
  const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId, requestId,
    request: { kind: 'input', message }, expectedRevision: snapshot.revision, checkpointJson: checkpoint });
  if (!admitted.lease) throw new Error('Missing run lease');
  const input = { messages: [{ role: 'user', content: message, timestamp: 1 }] };
  const model = await startModelRequest(admitted.lease, runtimeRequestDigest('model_request', input), JSON.stringify(input), checkpoint);
  await completeModelRequest(admitted.lease, model.id, JSON.stringify(fauxAssistantMessage(candidate)), checkpoint);
  const journal = new AgentRunJournal(admitted.lease);
  const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
  return { run, journal, sessionId: snapshot.sessionId };
}

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

describe('a declared write with a fabricated panel claim never opens a gate', () => {
  it('re-asks exactly once, creates no authorization and publishes the true unsubmitted state', async () => {
    const panelClaim = '请在上方确认面板中完成这笔转账，操作已提交等待你确认。';
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      fauxAssistantMessage(panelClaim),
      fauxAssistantMessage('请补充收款人和金额；本次未提交任何操作。'),
    ]);
    const turn = await runTurn({ message: TRANSFER_TO_ZHANGWEI }, { config, provider: script.provider });
    const db = getTestPrisma();
    // declaration + panel claim + exactly ONE bounded continuation.
    expect(script.calls()).toBe(3);
    // No real gate event, no parked action, no ledger movement: nothing backs the claimed panel.
    expect(hasGate(turn)).toBe(false);
    expect(await db.pendingAction.count()).toBe(0);
    // Only the `describe_turn` declaration was recorded; no controlled write invocation exists.
    expect(await db.toolInvocation.count({ where: { toolName: 'transfer_money' } })).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_CHECKING_BALANCE);
    expect(await db.transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -20037n } })).toBe(0);
    // The server narrates the true state, and the fabricated claim is nowhere in the transcript.
    expect(finalContent(turn)).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    const transcript = await transcriptOf(turn.sessionId);
    expect(transcript.at(-1)?.content).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    expect(transcript.some(message => message.content.includes('确认面板'))).toBe(false);
    expect((await loadSession(turn.sessionId))?.writeContinuation)
      .toMatchObject({ phase: 'completed', attempt: 1, declaredTools: ['transfer_money'] });
  });

  it('refuses a real write emitted during the corrective continuation instead of faking a panel', async () => {
    // Parameters ARE complete, so the model emits the genuine controlled call on the continuation.
    const panelClaim = '请在上方确认面板中完成这笔转账，操作已提交等待你确认。';
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      fauxAssistantMessage(panelClaim),
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
      fauxAssistantMessage('本次未提交转账。'),
    ]);
    const turn = await runTurn({ message: TRANSFER_TO_ZHANGWEI }, { config, provider: script.provider });
    const db = getTestPrisma();
    // declaration + claim + ONE continuation + the reply that follows the real (blocked) tool result.
    expect(script.calls()).toBe(4);
    // The corrective continuation is bracketed as a reply correction, so the gateway REFUSES the write
    // (a real server record) rather than opening or faking an authorization.
    expect(turn.events.filter(event => event.type === 'tool_end').map(event => event.toolEvent))
      .toContainEqual(expect.objectContaining({ toolName: 'transfer_money', status: 'blocked' }));
    expect(hasGate(turn)).toBe(false);
    expect(await db.pendingAction.count()).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_CHECKING_BALANCE);
    expect(await db.transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -20037n } })).toBe(0);
    // The refusal is narrated truthfully; the fabricated claim is never published as the outcome.
    expect(finalContent(turn)).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    expect((await transcriptOf(turn.sessionId)).some(message => message.content.includes('确认面板'))).toBe(false);
  });

  it('lets a real, complete write open a genuine gateway gate on the durable path', async () => {
    const { run, journal, sessionId } = await admittedDeclaredWriteRun('write-continuation-durable-gate',
      '请在上方确认面板中完成这笔转账。');
    const script = rawProvider([toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' })]);
    const status = await continueDurableRun(run, journal, [], { config, provider: script.provider });
    await journal.finish(status);
    const db = getTestPrisma();
    // The real call parks a real gate — a `PendingAction` plus a waiting tool invocation, not prose.
    expect(status).toBe('waiting_confirmation');
    expect(script.calls()).toBe(1);
    expect(await db.pendingAction.findMany({ select: { status: true, toolName: true } }))
      .toEqual([{ status: 'pending', toolName: 'transfer_money' }]);
    expect(await db.toolInvocation.findMany({ select: { status: true, toolName: true } }))
      .toEqual([{ status: 'waiting_confirmation', toolName: 'transfer_money' }]);
    // A parked gate moves no money until a human confirms it.
    expect(await checkingBalance()).toBe(SEEDED_CHECKING_BALANCE);
    expect(await durableUiEventTypes(run.id)).toContain('confirmation_required');
    // The fabricated claim itself is never published; only the real gate state reaches the user.
    expect(await durableUiText(run.id)).not.toContain('确认面板');
    expect((await loadSession(sessionId))?.writeContinuation).toMatchObject({ phase: 'completed', attempt: 1 });
  });

  it('never spends the continuation budget on a valid guidance clarification', async () => {
    const guidance = '{"guidance":{"code":"missing_details","fields":["recipient","amount"]}}';
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [fauxAssistantMessage(guidance)]);
    const turn = await runTurn({ message: '转一笔钱。' }, { config, provider: script.provider });
    const db = getTestPrisma();
    // declaration + guidance only: the server-rendered clarification replaces the continuation entirely.
    expect(script.calls()).toBe(2);
    expect(finalContent(turn)).toBe('请补充收款人（转给谁）、金额（多少钱），再继续处理；未创建操作授权。');
    expect(hasGate(turn)).toBe(false);
    expect(await db.pendingAction.count()).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_CHECKING_BALANCE);
    // The one-shot budget is NOT consumed by a reply its own path already handles.
    expect((await loadSession(turn.sessionId))?.writeContinuation).toBeUndefined();
  });

  it('does not fabricate a new operation or success for an already-completed transfer', async () => {
    const db = getTestPrisma();
    // First turn: a genuine declared write that a human really confirms and executes.
    const first = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '100.17' }),
      fauxAssistantMessage('请确认这笔转账。'),
    ]);
    const opened = await runTurn({ message: '给张伟转账100.17元' }, { config, provider: first.provider });
    const action = await db.pendingAction.findFirstOrThrow({ where: { sessionId: opened.sessionId } });
    const confirmed = await confirmAction(action.id, { sessionId: opened.sessionId, userId: DEMO_USER_ID,
      deps: { config, provider: first.provider } });
    expect(confirmed.ok).toBe(true);
    const afterFirst = await checkingBalance();
    expect(afterFirst).toBe(SEEDED_CHECKING_BALANCE - 10017n);

    // Repeat request: the declaration fires again, but the reply only claims the transfer is done.
    const duplicate = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      fauxAssistantMessage('这笔转账已成功完成，无需再次确认。'),
      fauxAssistantMessage('请补充收款人和金额；本次未提交任何操作。'),
    ]);
    const repeat = await runTurn({ sessionId: opened.sessionId, message: '再给张伟转账100.17元' }, { config, provider: duplicate.provider });
    // declaration + fabricated success claim + exactly ONE bounded continuation.
    expect(duplicate.calls()).toBe(3);
    // No new operation, no new gate, no second debit: only the first, real, human-confirmed transfer exists.
    expect(hasGate(repeat)).toBe(false);
    expect(await db.pendingAction.findMany({ select: { status: true, toolName: true } }))
      .toEqual([{ status: 'executed', toolName: 'transfer_money' }]);
    expect(await checkingBalance()).toBe(afterFirst);
    expect(await db.transaction.count({ where: { counterpartyId: 'contact_zhangwei', amountMinor: -10017n } })).toBe(1);
    // The truthful outcome replaces the fabricated success claim.
    expect(finalContent(repeat)).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    const transcript = await transcriptOf(opened.sessionId);
    expect(transcript.at(-1)?.content).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    expect(transcript.some(message => message.content.includes('已成功完成，无需再次确认'))).toBe(false);
    expect((await loadSession(opened.sessionId))?.writeContinuation).toMatchObject({ phase: 'completed', attempt: 1 });
  });

  it('applies the same one-shot policy on durable recovery and fabricates no panel', async () => {
    const { run, journal, sessionId } = await admittedDeclaredWriteRun('write-continuation-durable-prose',
      '请在上方确认面板中完成这笔转账。');
    // The replayed completed request emitted NO tool call, so recovery must prod exactly once.
    const script = rawProvider([fauxAssistantMessage('请补充收款人和金额；本次未提交任何操作。')]);
    const status = await continueDurableRun(run, journal, [], { config, provider: script.provider });
    await journal.finish(status);
    const db = getTestPrisma();
    expect(status).toBe('completed');
    expect(script.calls()).toBe(1);
    expect(await db.pendingAction.count()).toBe(0);
    expect(await checkingBalance()).toBe(SEEDED_CHECKING_BALANCE);
    // No panel, and the fabricated claim is never the published user-visible text.
    expect(await durableUiEventTypes(run.id)).not.toContain('confirmation_required');
    expect(await durableUiText(run.id)).not.toContain('确认面板');
    expect((await loadSession(sessionId))?.transcript.at(-1)?.content).toBe(DECLARED_TRANSFER_UNSUBMITTED);
    expect((await loadSession(sessionId))?.writeContinuation)
      .toMatchObject({ phase: 'completed', attempt: 1, declaredTools: ['transfer_money'] });
  });
});
