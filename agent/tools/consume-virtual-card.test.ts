/**
 * `consume_virtual_card` — the module's only card SPEND.
 *
 * Pure unit spec (no database): the SDK is partially mocked so the runner's parameter forwarding and
 * its model-facing summary can be asserted in isolation. The plan-parameter validator is the REAL
 * one, so schema acceptance/rejection is exercised end to end.
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

/** A complete SDK consumption snapshot — every financial value is exact decimal text. */
const CONSUMED = {
  consumption: { id: 'consumption_1', cardId: 'card_1', accountId: 'account_1', amount: '10.00', currency: 'CNY',
    category: 'DINING', merchant: 'Cafe', occurredAt: 1_700_000_000_000, executionKey: 'run-key', createdAt: 1 },
  card: { id: 'card_1', numberMasked: '****0001' },
  accountAvailableBalance: '990.00',
};
const SUMMARY = '虚拟卡 ****0001 已消费 ¥10.00（Cafe），绑定账户可用余额 ¥990.00';

describe('consume_virtual_card', () => {
  beforeEach(() => vi.resetAllMocks());

  it('is an agent-visible capability published under its exact catalog name', () => {
    expect(AGENT_TOOL_NAMES).toContain('consume_virtual_card');
    expect(createConsumeVirtualCardTool('owner').name).toBe('consume_virtual_card');
  });

  it('declares the spend inputs and NEVER a server-owned identity, execution key or fence', () => {
    expect(Object.keys(ConsumeVirtualCardParams.properties).sort())
      .toEqual(['amount', 'cardId', 'category', 'merchant', 'occurredAt']);
    const required = (ConsumeVirtualCardParams as { required?: string[] }).required ?? [];
    expect([...required].sort()).toEqual(['amount', 'cardId']);
  });

  it('accepts an exact decimal spend and rejects unusable amounts without coercion', () => {
    expect(() => validateBankingParameters('consume_virtual_card', {
      cardId: 'card_1', amount: '10.00', category: 'DINING', merchant: 'Cafe', occurredAt: 1_700_000_000_000,
    }, 'call')).not.toThrow();
    for (const amount of ['0.00', '-1.00', '10.000', 'abc', 10]) {
      expect(() => validateBankingParameters('consume_virtual_card', { cardId: 'card_1', amount }, 'call')).toThrow(AppError);
    }
  });

  it('rejects a model-supplied owner, execution key, session or non-integer occurrence time', () => {
    for (const forged of [
      { cardId: 'card_1', amount: '10.00', userId: 'attacker' },
      { cardId: 'card_1', amount: '10.00', executionKey: 'forged' },
      { cardId: 'card_1', amount: '10.00', sessionId: 'session_1' },
      { cardId: 'card_1', amount: '10.00', fence: {} },
      { cardId: 'card_1', amount: '10.00', occurredAt: 1.5 },
      { amount: '10.00' },
    ]) {
      expect(() => validateBankingParameters('consume_virtual_card', forged, 'call')).toThrow(AppError);
    }
  });

  it('binds the server-owned owner and takes the execution key from the run options, never from args', async () => {
    card.consumeCard.mockResolvedValue(CONSUMED);
    const result = await runConsumeVirtualCard('owner', {
      cardId: 'card_1', amount: '10.00', category: 'DINING', merchant: 'Cafe', occurredAt: 1_700_000_000_000,
      userId: 'attacker', executionKey: 'forged',
    }, { idempotencyKey: 'run-key' });

    expect(card.consumeCard).toHaveBeenCalledWith({
      userId: 'owner', cardId: 'card_1', amount: '10.00', category: 'DINING', merchant: 'Cafe',
      occurredAt: 1_700_000_000_000, executionKey: 'run-key',
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(SUMMARY);
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
