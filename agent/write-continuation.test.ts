/**
 * The bounded write continuation exists for ONE defect: a LIVE declared-write turn whose final
 * response is ordinary prose that claims a confirmation panel without emitting the declared tool
 * call. A server-interpretable reply (protocol envelope needing format repair, or a valid guidance
 * envelope) belongs to its own established path, so the continuation must not engage — and must not
 * spend its one-shot budget — for those.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { loadSession, runTurn } from '@/agent';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const config = { llmMode: 'live' as const, llmProvider: 'deepseek', llmModel: 'scripted', demoUserId: DEMO_USER_ID };
const lastTranscript = async (sessionId: string) => (await loadSession(sessionId))?.transcript.at(-1)?.content;
/** The server-authored state published when a declared write stayed unsubmitted. */
const DECLARED_TRANSFER_UNSUBMITTED =
  '本轮声明要办理：转账。系统未记录到该操作的提交结果或确认入口，操作尚未提交。请核对并补充完整信息后重新发送；如已有操作卡，请通过卡片继续处理。';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

describe('bounded write continuation for declared-but-unemitted writes', () => {
  it('requests exactly one continuation for ordinary prose that claims a panel, then states the true outcome',
    async () => {
      const panelClaim = '请在上方确认面板中完成这笔转账，操作已提交等待你确认。';
      const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
        fauxAssistantMessage(panelClaim),
        fauxAssistantMessage('请补充收款人和金额；本次未提交任何操作。'),
      ]);
      const turn = await runTurn({ message: 'Transfer 200.00 to the saved contact.' }, { config, provider: script.provider });
      // declaration + panel claim + exactly ONE bounded continuation; the fabricated claim is never published.
      expect(script.calls()).toBe(3);
      expect(await lastTranscript(turn.sessionId)).toBe(DECLARED_TRANSFER_UNSUBMITTED);
      expect(turn.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
      expect(await getTestPrisma().pendingAction.count()).toBe(0);
      expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
      expect((await loadSession(turn.sessionId))?.writeContinuation).toMatchObject({ phase: 'completed', attempt: 1 });
    });

  it('never spends the continuation budget on a valid guidance envelope', async () => {
    const raw = '{"guidance":{"code":"missing_details","fields":["product","amount"]}}';
    const script = scriptedProvider({ purpose: 'operation', operations: ['subscribe_investment'] }, [fauxAssistantMessage(raw)]);
    const turn = await runTurn({ message: 'Purchase product A for 1000.66.' }, { config, provider: script.provider });
    // declaration + guidance only: the continuation must not prod the model again.
    expect(script.calls()).toBe(2);
    expect(await lastTranscript(turn.sessionId)).toBe('请补充理财产品、金额（多少钱），再继续处理；未创建操作授权。');
    expect((await loadSession(turn.sessionId))?.writeContinuation).toBeUndefined();
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });

  it('leaves a protocol envelope to format repair instead of the write continuation', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      fauxAssistantMessage('{"role":"assistant","content":"Invalid protocol"}'),
      fauxAssistantMessage('No transfer was executed during output correction.'),
    ]);
    const turn = await runTurn({ message: 'Transfer 200.00 to the saved contact.' }, { config, provider: script.provider });
    expect(script.calls()).toBe(3);
    expect(await lastTranscript(turn.sessionId)).toBe('No transfer was executed during output correction.');
    const saved = await loadSession(turn.sessionId);
    expect(saved?.writeContinuation).toBeUndefined();
    expect(saved?.replyRepair).toMatchObject({ phase: 'completed', attempt: 1 });
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });
});
