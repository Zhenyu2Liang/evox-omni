import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { SPENDING_CATEGORIES } from '@/lib/contracts/spending';
import { runReserveBudget } from '@/agent/tools/budget';
import { runCreateScheduledTask } from '@/agent/tools/task';
import { runTransferMoney } from '@/agent/tools/transfer';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

useFreshDatabase();

const RUN_AT = Date.parse('2099-01-02T09:00:00+08:00');

describe('write domain boundaries', () => {
  it('requires owner identity for budget release and preserves a foreign envelope', async () => {
    const budget = await banking.budget.reserveBudget({ userId: DEMO_USER_ID, name: 'Owned envelope', amount: '12.00' });
    await expect(banking.budget.releaseBudget(budget.id, 'foreign-user')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getTestPrisma().budget.findUniqueOrThrow({ where: { id: budget.id } })).status).toBe('RESERVED');
    expect((await banking.budget.releaseBudget(budget.id, DEMO_USER_ID)).status).toBe('RELEASED');
    expect((await banking.budget.releaseBudget(budget.id, DEMO_USER_ID)).status).toBe('RELEASED');
  });

  it('treats blank transfer identities as absent without creating contradictory replay receipts', async () => {
    const input = { userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '1.00', idempotencyKey: ' ' };
    const first = await banking.transfer.createTransfer(input);
    const second = await banking.transfer.createTransfer(input);
    expect(first.transactionId).not.toBe(second.transactionId);
    expect(await getTestPrisma().executionReceipt.count({ where: { userId: DEMO_USER_ID, key: '' } })).toBe(0);
    expect(await banking.transfer.getCommittedTransfer(input)).toBeNull();
  });

  it('rejects malformed optional funding selectors instead of defaulting to the checking account', async () => {
    const before = (await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor;
    const outcome = await runTransferMoney(DEMO_USER_ID, { contactId: 'contact_zhangwei', amount: '1.00', sourceAccountId: 42 });
    expect(outcome).toMatchObject({ ok: false, errorCode: 'VALIDATION' });
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(before);
  });

  it('rejects release of a consumed budget', async () => {
    const budget = await banking.budget.reserveBudget({ userId: DEMO_USER_ID, name: 'Consumed envelope', amount: '12.00' });
    await getTestPrisma().budget.update({ where: { id: budget.id }, data: { status: 'USED' } });
    await expect(banking.budget.releaseBudget(budget.id, DEMO_USER_ID)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('requires owner identity for schedule cancellation without modifying foreign intent', async () => {
    const task = await banking.task.createScheduledTask({ userId: DEMO_USER_ID, name: 'Owned reminder', kind: 'REMINDER', runAt: RUN_AT });
    await expect(banking.task.cancelScheduledTask(task.id, 'foreign-user')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getTestPrisma().scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('SCHEDULED');
  });

  it('derives future authorization requirements from the supported intent kind', async () => {
    const reminder = await banking.task.createScheduledTask({ userId: DEMO_USER_ID, name: 'Reminder', kind: 'REMINDER', runAt: RUN_AT });
    expect(reminder.requiresConfirmation).toBe(false);
    const payment = await banking.task.createScheduledTask({ userId: DEMO_USER_ID, name: 'Payment', kind: 'PAYMENT', runAt: RUN_AT,
      payload: { contactId: 'contact_zhangwei', amount: '12.00' } });
    expect(payment.requiresConfirmation).toBe(true);
  });

  it('rejects invalid names and date epochs before reserving a budget', async () => {
    const before = await getTestPrisma().budget.count();
    for (const patch of [{ name: ' ' }, { dueDate: 1.5 }, { dueDate: 8640000000000001 }]) {
      await expect(banking.budget.reserveBudget({ userId: DEMO_USER_ID, name: 'Envelope', amount: '12.00', ...patch }))
        .rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(await getTestPrisma().budget.count()).toBe(before);
  });

  it('rejects invalid schedule payloads before persistence', async () => {
    const before = await getTestPrisma().scheduledTask.count();
    for (const payload of [
      {},
      { contactId: 'contact_zhangwei', name: 'Recipient', amount: '12.00' },
      { contactId: 'contact_zhangwei', amount: '-12.00' },
      { contactId: 'contact_zhangwei', amount: '12.00', toolName: 'transfer_money' },
    ]) {
      await expect(banking.task.createScheduledTask({ userId: DEMO_USER_ID, name: 'Payment', kind: 'TRANSFER', runAt: RUN_AT, payload }))
        .rejects.toMatchObject({ code: 'VALIDATION' });
    }
    await expect(banking.task.createScheduledTask({ userId: DEMO_USER_ID, name: 'Reminder', kind: 'REMINDER', runAt: 1.5 }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await getTestPrisma().scheduledTask.count()).toBe(before);
  });

  it('ignores untrusted model replay identities in low-level runners', async () => {
    const args = { name: 'Independent envelope', amount: '12.00', idempotencyKey: 'model-owned-key' };
    const first = await runReserveBudget(DEMO_USER_ID, args);
    const second = await runReserveBudget(DEMO_USER_ID, args);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((first.data as { id: string }).id).not.toBe((second.data as { id: string }).id);
    const scheduleArgs = { name: 'Independent reminder', kind: 'REMINDER', runAt: RUN_AT, idempotencyKey: 'model-owned-key' };
    const taskOne = await runCreateScheduledTask(DEMO_USER_ID, scheduleArgs);
    const taskTwo = await runCreateScheduledTask(DEMO_USER_ID, scheduleArgs);
    expect(taskOne.ok).toBe(true);
    expect(taskTwo.ok).toBe(true);
    expect((taskOne.data as { id: string }).id).not.toBe((taskTwo.data as { id: string }).id);
    expect(await getTestPrisma().budget.count({ where: { idempotencyKey: 'model-owned-key' } })).toBe(0);
    expect(await getTestPrisma().scheduledTask.count({ where: { idempotencyKey: 'model-owned-key' } })).toBe(0);
  });

  it('rejects unsupported categories and lost-card limit updates without removing existing limits', async () => {
    const cardId = 'card_credit';
    const before = await getTestPrisma().cardLimit.findMany({ where: { cardId } });
    await expect(banking.card.setCardLimit({ userId: DEMO_USER_ID, cardId, category: 'unsupported-category', amount: '1.00' }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await banking.card.reportLostCard(cardId, DEMO_USER_ID);
    await expect(banking.card.setCardLimit({ userId: DEMO_USER_ID, cardId, category: SPENDING_CATEGORIES[3], amount: '1.00' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getTestPrisma().cardLimit.findMany({ where: { cardId } })).toEqual(before);
  });

  it('disables reminders on cancellation and rejects later reminder changes', async () => {
    await banking.subscription.setSubscriptionReminder('sub_netflix', true, DEMO_USER_ID);
    expect((await banking.subscription.cancelSubscription('sub_netflix', DEMO_USER_ID)).remind).toBe(false);
    await expect(banking.subscription.setSubscriptionReminder('sub_netflix', true, DEMO_USER_ID))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await getTestPrisma().subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).remind).toBe(false);
  });
});
