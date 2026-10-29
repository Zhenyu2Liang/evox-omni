import { describe, expect, it } from 'vitest';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runTurn, loadSession } from '@/agent';
import { confirmAction } from '@/agent/confirmation';
import { scriptedProvider } from '../helpers/scripted-provider';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import type { AppConfig } from '@/lib/config';
import { getOrCreateSession, saveSession } from '@/agent/session';
import { SCHEDULE_TIME_QUESTION } from '@/agent/scheduled-input';

useFreshDatabase();
const config: AppConfig = { llmMode: 'live', llmProvider: 'schedule-regression', llmModel: 'faux', demoUserId: 'user_liming' };
const request = '帮我设置个定时转账，到10月30日给妈妈转账300元';
const question = SCHEDULE_TIME_QUESTION;
const args = { name: '给妈妈转账300元', kind: 'TRANSFER', runAtLocal: '2026-10-30T10:00', payload: { contactId: 'contact_mama', amount: '300.00' } };
const clarify = () => scriptedProvider({ purpose: 'operation', operations: ['create_scheduled_task'], needsInput: true }, [fauxAssistantMessage(question)]);
const tool = () => fauxAssistantMessage([fauxToolCall('create_scheduled_task', args)], { stopReason: 'toolUse' });

describe('scheduled transfers require an explicit execution time', () => {
  it('separates a rejected model payload from execution failure, then creates exactly one task', async () => {
    const bad = { ...args, payload: { ...args.payload, phone: '136****0004', recipientName: '妈妈' } };
    const provider = scriptedProvider({ purpose: 'operation', operations: ['create_scheduled_task'], needsInput: false }, [
      fauxAssistantMessage([fauxToolCall('create_scheduled_task', bad)], { stopReason: 'toolUse' }), tool(),
    ]);
    const result = await runTurn({ message: '2026年10月30日上午10点给妈妈转账300元' }, { config, provider: provider.provider });
    const preflight = result.events.find(event => event.type === 'tool_end' && event.toolEvent.summary === 'chat.error.parametersNotSubmitted');
    expect(preflight).toMatchObject({ type: 'tool_end', toolEvent: { status: 'blocked' } });
    expect(result.events.some(event => event.type === 'card' && event.card.type === 'error')).toBe(false);
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
    expect(await getTestPrisma().scheduledTask.count()).toBe(2);
    const action = await getTestPrisma().pendingAction.findFirstOrThrow();
    expect(JSON.parse(action.argsJson).payload).toEqual(args.payload);
    await confirmAction(action.id, { sessionId: result.sessionId, userId: config.demoUserId });
    expect(await getTestPrisma().scheduledTask.count({ where: { name: args.name } })).toBe(1);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });
  it('keeps a time clarification when the correction is mislabeled conversation and drops the old preview', async () => {
    const fake = fauxProvider();
    const models = createModels(); models.setProvider(fake.provider);
    fake.setResponses([
      fauxAssistantMessage('这个定时任务已提交，目前等待确认。执行时间2026-10-30 09:00。'),
      fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'conversation', operations: [], needsInput: true })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('之前提交的定时任务仍在等待确认，2026-10-30 09:00。请告诉我10月30日几点执行？'),
    ]);
    const response = await runTurn({ message: request }, { config, provider: { model: fake.getModel(), streamFn: models.streamSimple.bind(models) } });
    const prose = response.events.flatMap(event => event.type === 'message_end' && event.message.role === 'assistant' ? [event.message.content] : []).join('\n');
    expect(prose).toContain(SCHEDULE_TIME_QUESTION);
    expect(prose).not.toContain('09:00');
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });
  it('does not publish a false old waiting-state narrative before requesting the missing time', async () => {
    const fake = fauxProvider();
    const models = createModels();
    models.setProvider(fake.provider);
    fake.setResponses([
      fauxAssistantMessage('这次提交已进入等待确认状态，尚未执行。\n定时转账的执行时间是2026-10-30 09:00。'),
      fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'operation', operations: ['create_scheduled_task'], needsInput: false })], { stopReason: 'toolUse' }),
    ]);
    const response = await runTurn({ message: request }, { config,
      provider: { model: fake.getModel(), streamFn: models.streamSimple.bind(models) } });
    const prose = response.events.flatMap(event => event.type === 'message_end' && event.message.role === 'assistant' ? [event.message.content] : []).join('\n');
    expect(prose).toContain(SCHEDULE_TIME_QUESTION);
    expect(prose).not.toContain('09:00');
    expect(prose).not.toContain('已进入等待确认');
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });
  it('blocks a guessed time even when declaration and write arrive in one assistant message', async () => {
    const fake = fauxProvider();
    const models = createModels();
    models.setProvider(fake.provider);
    fake.setResponses([fauxAssistantMessage([
      fauxToolCall('describe_turn', { purpose: 'operation', operations: ['create_scheduled_task'], needsInput: false }),
      fauxToolCall('create_scheduled_task', { ...args, runAtLocal: '2026-10-30T09:00' }),
    ], { stopReason: 'toolUse' })]);
    const response = await runTurn({ message: request }, { config,
      provider: { model: fake.getModel(), streamFn: models.streamSimple.bind(models) } });
    expect(response.events.some(event => event.type === 'message_end' && event.message.content === SCHEDULE_TIME_QUESTION)).toBe(true);
    expect(response.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().scheduledTask.count()).toBe(2);
  });
  it.each([false, true])('overrides a ready model and an old 09:00 suggestion before writes (workflow=%s)', async workflow => {
    const old = await getOrCreateSession(config.demoUserId);
    old.agentState.messages.push({ role: 'user', timestamp: 1, content: [{ type: 'text', text: request }] },
      fauxAssistantMessage('已按2026-10-30 09:00为妈妈安排转账300元。'));
    await saveSession(old);
    const planCall = fauxAssistantMessage([fauxToolCall('submit_plan', { goal: '再次按旧时间转账', nodes: [{ id: 'schedule', name: '创建定时任务', kind: 'tool',
      tool: 'create_scheduled_task', dependencies: [], args: { ...args, runAtLocal: '2026-10-30T09:00' } }] })], { stopReason: 'toolUse' });
    const provider = scriptedProvider({ purpose: 'operation', operations: ['create_scheduled_task'], needsInput: false, workflow }, [workflow ? planCall : tool()]);
    const response = await runTurn({ sessionId: old.sessionId, message: request }, { config, provider: provider.provider });
    expect(response.events.some(event => event.type === 'message_end' && event.message.content === SCHEDULE_TIME_QUESTION)).toBe(true);
    expect(provider.calls()).toBe(1);
    expect((await loadSession(old.sessionId))?.intent).toMatchObject({ needsInput: true, requiredInput: 'scheduled_time' });
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().agentTask.count()).toBe(0);
    expect(await getTestPrisma().scheduledTask.count()).toBe(2);
  });
  it('asks for the time, keeps it missing after a bare submit, and creates no authorization', async () => {
    const first = await runTurn({ message: request }, { config, provider: clarify().provider });
    const second = await runTurn({ sessionId: first.sessionId, message: '提交' }, { config, provider: clarify().provider });
    for (const response of [first, second]) {
      expect(response.events.some(event => event.type === 'message_end' && event.message.content === question)).toBe(true);
      expect(response.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    }
    expect((await loadSession(first.sessionId))?.intent?.needsInput).toBe(true);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().scheduledTask.count()).toBe(2);
  });
  it('uses the supplied time in one direct confirmation and saves only after approval', async () => {
    const first = await runTurn({ message: request }, { config, provider: clarify().provider });
    const ready = scriptedProvider({ purpose: 'operation', operations: ['create_scheduled_task'], needsInput: false, workflow: false }, [tool()]);
    const response = await runTurn({ sessionId: first.sessionId, message: '上午10点，北京时间' }, { config, provider: ready.provider });
    expect(response.events.some(event => event.type === 'confirmation_required')).toBe(true);
    const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: response.sessionId } });
    expect(JSON.parse(action.argsJson).runAtLocal).toBe('2026-10-30T10:00');
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
    expect(await getTestPrisma().scheduledTask.count()).toBe(2);
    expect((await confirmAction(action.id, { sessionId: response.sessionId, userId: config.demoUserId })).ok).toBe(true);
    const task = await getTestPrisma().scheduledTask.findFirstOrThrow({ where: { name: args.name } });
    expect(task.runAt.toISOString()).toBe('2026-10-30T02:00:00.000Z');
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });
  it('blocks an invented execution time while the current declaration still needs input', async () => {
    const provider = scriptedProvider({ purpose: 'operation', operations: ['create_scheduled_task'], needsInput: true }, [tool()]);
    await runTurn({ message: request }, { config, provider: provider.provider });
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().scheduledTask.count()).toBe(2);
  });
});
