import { expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { loadSession, runTurn } from '@/agent';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import { NO_SUBMITTED_OPERATION } from '@/agent/reply-safety';

useFreshDatabase();
const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'user_liming' };
const claim = '转账 ¥200.00 的操作已提交，正在等待你的确认与验证后才会执行。';
const raw = (responses: ReturnType<typeof fauxAssistantMessage>[]) => {
  const registration = fauxProvider();
  const models = createModels();
  models.setProvider(registration.provider);
  registration.setResponses(responses);
  return { model: registration.getModel(), streamFn: models.streamSimple.bind(models) };
};

it.each([false, true])('replaces a fabricated submission with server facts even with missing or incorrect declaration (%s)', async declared => {
  const provider = declared ? scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(claim)]).provider
    : raw([fauxAssistantMessage(claim), fauxAssistantMessage('当前没有提交任何操作，请重新核对办理信息。')]);
  const result = await runTurn({ message: '给139****0002转200元' }, { config, provider });
  const saved = await loadSession(result.sessionId);
  expect(saved?.transcript.at(-1)?.content).toBe(NO_SUBMITTED_OPERATION);
  expect(saved?.transcript.some(message => message.content.includes('操作已提交'))).toBe(false);
  expect(result.events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).not.toContain('操作已提交');
  expect(await getTestPrisma().pendingAction.count()).toBe(0);
  expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
});

it('stops at a missing-card question instead of asking the model to choose a card on continuation', async () => {
  const intro = scriptedProvider({ purpose: 'advice', operations: [] }, [fauxAssistantMessage('A：商家退款；B：怀疑盗刷。B 需要先确定具体卡片。')]);
  const first = await runTurn({ message: '请按 A 商家退款、B 怀疑盗刷说明，供我选择。' }, { config, provider: intro.provider });
  const question = '记录没有指明是哪张卡，请告诉我是信用卡、借记卡还是虚拟卡？';
  const script = scriptedProvider({ purpose: 'operation', operations: ['freeze_card'], needsInput: true }, [
    fauxAssistantMessage(question),
    fauxAssistantMessage([fauxToolCall('freeze_card', { cardId: 'card_credit' })], { stopReason: 'toolUse' }),
  ]);
  const result = await runTurn({ sessionId: first.sessionId, message: 'B' }, { config, provider: script.provider });
  expect(script.calls()).toBe(2);
  expect((await loadSession(result.sessionId))?.transcript.at(-1)?.content).toBe(question);
  expect(await getTestPrisma().pendingAction.count()).toBe(0);
  expect(await getTestPrisma().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).toMatchObject({ status: 'ACTIVE' });
});

it('can correct an undeclared submission claim by creating one real confirmation for the current complete request', async () => {
  const provider = raw([
    fauxAssistantMessage(claim),
    fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'operation', operations: ['transfer_money'], needsInput: false })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.00' })], { stopReason: 'toolUse' }),
  ]);
  const result = await runTurn({ message: '给张伟转200元' }, { config, provider });
  expect(await getTestPrisma().pendingAction.findMany()).toMatchObject([{ toolName: 'transfer_money', status: 'pending' }]);
  expect((await loadSession(result.sessionId))?.transcript.at(-1)?.content).toContain('尚未执行，等待确认');
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
});

it('treats omitted operation readiness as missing input and blocks a guessed write before MFA creation', async () => {
  const provider = raw([
    fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'operation', operations: ['freeze_card'] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxToolCall('freeze_card', { cardId: 'card_credit' })], { stopReason: 'toolUse' }),
  ]);
  await runTurn({ message: 'B' }, { config, provider });
  expect(await getTestPrisma().pendingAction.count()).toBe(0);
  expect(await getTestPrisma().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).toMatchObject({ status: 'ACTIVE' });
});

it('retains a corrective missing-choice question together with the authoritative unsubmitted state', async () => {
  const question = '请选择要冻结的卡片：信用卡、借记卡还是虚拟卡？';
  const provider = raw([
    fauxAssistantMessage('冻结操作已提交，请在面板确认。'),
    fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'operation', operations: ['freeze_card'], needsInput: true })], { stopReason: 'toolUse' }),
    fauxAssistantMessage(question),
  ]);
  const result = await runTurn({ message: 'B' }, { config, provider });
  const content = (await loadSession(result.sessionId))?.transcript.at(-1)?.content;
  expect(content).toContain(question);
  expect(content).toContain(NO_SUBMITTED_OPERATION);
  expect(content).not.toContain('冻结操作已提交');
  expect(await getTestPrisma().pendingAction.count()).toBe(0);
  expect(await getTestPrisma().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).toMatchObject({ status: 'ACTIVE' });
});
