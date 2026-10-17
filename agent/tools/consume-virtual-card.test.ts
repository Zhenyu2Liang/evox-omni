/**
 * `consume_virtual_card` — the module's only card SPEND.
 *
 * Pure unit spec (no database): the SDK is partially mocked so the runner's parameter forwarding and
 * its model-facing summary can be asserted in isolation. The plan-parameter validator is the REAL
 * one, so schema acceptance/rejection is exercised end to end.
 *
 * The spend's BOOKING time is SERVER-OWNED (business clock, UTC+08:00 month window). This spec also
 * proves that any model-supplied time field is refused with `VALIDATION` BEFORE the SDK is reached,
 * i.e. a forged date can move neither funds nor the monthly-limit window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const card = vi.hoisted(() => ({ consumeCard: vi.fn() }));

vi.mock('@/banking-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/banking-sdk')>();
  return {
    ...actual,
    banking: { ...actual.banking, card: { ...actual.banking.card, consumeCard: card.consumeCard } },
  };
});

import { ConsumeVirtualCardParams, createConsumeVirtualCardTool, runConsumeVirtualCard } from '@/agent/tools/card';
import { validateBankingParameters } from '@/agent/tools/plan-parameters';
import { AGENT_TOOL_NAMES } from '@/lib/contracts/tool-catalog';
import { AppError } from '@/lib/errors';

/** The deliberate refusal reason shared by the tool guard and the plan-parameter validator. */
const SERVER_TIME_REASON = '消费入账时间由服务端决定';

/** A complete SDK consumption snapshot — every financial value is exact decimal text. */
const CONSUMED = {
  consumption: { id: 'consumption_1', cardId: 'card_1', accountId: 'account_1', amount: '10.00', currency: 'CNY',
    category: 'DINING', merchant: 'Cafe', occurredAt: 1_700_000_000_000, executionKey: 'run-key', createdAt: 1 },
  card: { id: 'card_1', numberMasked: '****0001', linkedAccountNumber: '6222****8888',
    accountAvailableBalance: '990.00', payableAmount: '90.00', monthlyLimit: '100.00' },
  accountAvailableBalance: '990.00',
};
/** Server-authored sentence: only the facts the returned snapshot actually carries. */
const SUMMARY = '虚拟卡 ****0001 已消费 ¥10.00（Cafe），关联账户 6222****8888，'
  + '绑定账户可用余额 ¥990.00，月消费限额 ¥100.00，当前可支付金额 ¥90.00';

/** Capture the thrown error so its code, message and detail can be asserted. */
function captureThrow(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the forged-time call to be refused.');
}

describe('consume_virtual_card', () => {
  beforeEach(() => vi.resetAllMocks());

  it('is an agent-visible capability published under its exact catalog name', () => {
    expect(AGENT_TOOL_NAMES).toContain('consume_virtual_card');
    expect(createConsumeVirtualCardTool('owner').name).toBe('consume_virtual_card');
  });

  it('declares the spend inputs and NEVER a server-owned identity, execution key, fence or booking time', () => {
    // The booking time is server-owned, so the schema publishes no date/time field at all.
    expect(Object.keys(ConsumeVirtualCardParams.properties).sort())
      .toEqual(['amount', 'cardId', 'category', 'merchant']);
    const required = (ConsumeVirtualCardParams as { required?: string[] }).required ?? [];
    expect([...required].sort()).toEqual(['amount', 'cardId']);
  });

  it('accepts an exact decimal spend and rejects unusable amounts without coercion', () => {
    // No `occurredAt`: the booking time is never a model input any more.
    expect(() => validateBankingParameters('consume_virtual_card', {
      cardId: 'card_1', amount: '10.00', category: 'DINING', merchant: 'Cafe',
    }, 'call')).not.toThrow();
    for (const amount of ['0.00', '-1.00', '10.000', 'abc', 10]) {
      expect(() => validateBankingParameters('consume_virtual_card', { cardId: 'card_1', amount }, 'call')).toThrow(AppError);
    }
  });

  it('rejects a model-supplied owner, execution key, session or fence', () => {
    for (const forged of [
      { cardId: 'card_1', amount: '10.00', userId: 'attacker' },
      { cardId: 'card_1', amount: '10.00', executionKey: 'forged' },
      { cardId: 'card_1', amount: '10.00', sessionId: 'session_1' },
      { cardId: 'card_1', amount: '10.00', fence: {} },
      { amount: '10.00' },
    ]) {
      expect(() => validateBankingParameters('consume_virtual_card', forged, 'call')).toThrow(AppError);
    }
  });

  it('refuses a model-supplied booking time with the deliberate server-owned-time reason', () => {
    // Any client time field would forge the booking time — and the monthly-limit window with it — so
    // the validator refuses it by reason (not as a generic "Unsupported parameters" key) and tags the call.
    for (const args of [
      { cardId: 'card_1', amount: '10.00', occurredAt: 1_700_000_000_000 },
      { cardId: 'card_1', amount: '10.00', bookedAt: 1_700_000_000_000 },
      { cardId: 'card_1', amount: '10.00', timestamp: 1_700_000_000_000 },
      { cardId: 'card_1', amount: '10.00', occurredAt: 1.5 },
    ]) {
      const error = captureThrow(() => validateBankingParameters('consume_virtual_card', args, 'call'));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION');
      expect((error as AppError).message).toContain(SERVER_TIME_REASON);
      expect((error as AppError).message).not.toContain('Unsupported parameters');
      expect((error as AppError).detail).toMatchObject({ callId: 'call' });
    }
  });

  it('refuses a forged booking time before the SDK runs, so nothing is charged or booked', async () => {
    // The guard sits inside the runner's try, before `banking.card.consumeCard` — a forged time can
    // therefore never debit the linked account, write a `CARD` ledger row or a `CardConsumption` row.
    const result = await runConsumeVirtualCard('owner',
      { cardId: 'card_1', amount: '10.00', occurredAt: 1_700_000_000_000 }, { idempotencyKey: 'run-key' });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION');
    expect(result.error).toContain(SERVER_TIME_REASON);
    expect(card.consumeCard).not.toHaveBeenCalled();

    // Pi can hand over extra runtime keys, so the tool wrapper is exercised with the same forged field.
    const tool = createConsumeVirtualCardTool('owner');
    const forgedInput = { cardId: 'card_1', amount: '10.00', timestamp: 1_700_000_000_000 };
    const projected = await tool.execute('write-call', forgedInput as Parameters<typeof tool.execute>[1]);
    expect(projected.isError).toBe(true);
    expect(card.consumeCard).not.toHaveBeenCalled();
  });

  it('binds the server-owned owner, takes the execution key from the run options and forwards no time', async () => {
    card.consumeCard.mockResolvedValue(CONSUMED);
    const result = await runConsumeVirtualCard('owner', {
      cardId: 'card_1', amount: '10.00', category: 'DINING', merchant: 'Cafe',
      userId: 'attacker', executionKey: 'forged',
    }, { idempotencyKey: 'run-key' });

    // EXACTLY these keys: no `occurredAt` (server-owned booking time) and no caller-supplied identity.
    expect(card.consumeCard).toHaveBeenCalledWith({
      userId: 'owner', cardId: 'card_1', amount: '10.00', category: 'DINING', merchant: 'Cafe',
      executionKey: 'run-key',
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(SUMMARY);
  });

  it('reports the server facts of the spend in one readable summary sentence', async () => {
    card.consumeCard.mockResolvedValue(CONSUMED);
    const result = await runConsumeVirtualCard('owner', { cardId: 'card_1', amount: '10.00', merchant: 'Cafe' },
      { idempotencyKey: 'run-key' });

    expect(result.summary).toContain('金额');
    expect(result.summary).toContain('¥10.00');
    expect(result.summary).toContain('关联账户 6222****8888');
    expect(result.summary).toContain('绑定账户可用余额 ¥990.00');
    expect(result.summary).toContain('月消费限额 ¥100.00');
    expect(result.summary).toContain('当前可支付金额 ¥90.00');
  });

  it('sends the returned spend facts to Pi content and keeps them in details', async () => {
    card.consumeCard.mockResolvedValue(CONSUMED);
    const projected = await createConsumeVirtualCardTool('owner').execute('write-call', { cardId: 'card_1', amount: '10.00' });

    expect(projected.isError).not.toBe(true);
    expect(projected.details).toBe(CONSUMED);
    const [summary, data] = projected.content;
    if (summary.type !== 'text' || data.type !== 'text') throw new Error('Expected model-visible spend facts.');
    expect(summary.text).toBe(SUMMARY);
    expect(JSON.parse(data.text)).toMatchObject({
      ok: true, data: { consumption: { amount: '10.00', category: 'DINING' }, accountAvailableBalance: '990.00' },
    });
  });

  it('keeps a typed SDK refusal model-visible in the native error envelope', async () => {
    card.consumeCard.mockRejectedValue(new AppError('INSUFFICIENT_FUNDS', '绑定账户可用余额不足。'));
    const projected = await createConsumeVirtualCardTool('owner').execute('write-call', { cardId: 'card_1', amount: '10.00' });

    expect(projected.isError).toBe(true);
    const content = projected.content[0];
    if (content.type !== 'text') throw new Error('Expected a model-visible failure envelope.');
    expect(JSON.parse(content.text)).toMatchObject({
      bankingError: { code: 'INSUFFICIENT_FUNDS', message: '绑定账户可用余额不足。', retryable: false },
    });
  });
});
