/**
 * TEMPORARY smoke spec for the `./tests/helpers` harness (faux-agent + scenario).
 * Proves the harness actually runs green end-to-end against the real security gateway + SDK + DB.
 * (Left in the worktree intentionally — the manager runs/deletes it during final validation.)
 */
import { describe, expect, it } from 'vitest';
import { useFreshDatabase, getTestPrisma } from './db';
import { buildFauxAgent, tool, final } from './faux-agent';
import { runTurn, confirmAction, newSessionId, cardsOfType, toolEventsOf } from './scenario';
import { ACCOUNTS, CONTACTS } from './fixtures';

useFreshDatabase();

describe('helpers smoke — GREEN balance', () => {
  it('executes get_balance inline and surfaces a balance card + narration', async () => {
    const sessionId = newSessionId('smoke');
    const agent = buildFauxAgent({
      sessionId,
      script: [tool('get_balance', {}), final('您的余额是 ¥23,580.00')],
    });

    const res = await runTurn({ sessionId, message: '查询我的余额', agent });

    expect(res.error).toBeUndefined();
    const balanceCards = cardsOfType(res, 'balance');
    expect(balanceCards.length).toBeGreaterThan(0);
    expect(res.text).not.toBe('');
    expect(res.text).toContain('23,580.00');

    const balanceEvents = toolEventsOf(res, 'get_balance');
    expect(balanceEvents.some((e) => e.status === 'success')).toBe(true);
  });
});

describe('helpers smoke — YELLOW transfer confirm', () => {
  it('blocks transfer_money ¥200, then confirm executes the original args', async () => {
    const prisma = getTestPrisma();
    const sessionId = newSessionId('smoke');
    const args = { contactId: CONTACTS[0].id, amount: 200, remark: 'AA' };

    const agent = buildFauxAgent({
      sessionId,
      script: [
        tool('transfer_money', args),
        final('该操作需你确认后方可执行，请前往页面确认。'),
        final('已成功向张伟转账 ¥200.00，账户余额 ¥23,380.00。'),
      ],
    });

    const res = await runTurn({ sessionId, message: '给张伟转200元，备注AA', agent });

    expect(res.confirmation).toBeDefined();
    const actionId = res.confirmation!.actionId;
    expect(cardsOfType(res, 'confirmation').length).toBeGreaterThan(0);

    const pending = await prisma.pendingAction.findUnique({ where: { id: actionId } });
    expect(pending).not.toBeNull();
    expect(pending!.status).toBe('pending');

    const confirmed = await confirmAction(agent, actionId);
    expect(confirmed.error).toBeUndefined();

    const settled = await prisma.pendingAction.findUnique({ where: { id: actionId } });
    expect(['confirmed', 'executed']).toContain(settled!.status);

    const account = await prisma.account.findUnique({ where: { id: ACCOUNTS[0].id } });
    expect(account!.balance).toBe(23380);
  });
});
