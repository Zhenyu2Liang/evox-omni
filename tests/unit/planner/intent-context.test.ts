import { describe, expect, it } from 'vitest';
import { advanceConversationIntent } from '@/agent/intent-context';

const transfer = '\u7ed9\u5f20\u4f1f\u8f6c\u8d26';
const secondTransfer = '\u7ed9\u738b\u82b3\u8f6c\u8d26';
const currency = '\u5143';
const then = '\uff0c\u7136\u540e';

describe('conversation intent revisions', () => {
  it('preserves a complete composite request when the user clarifies one missing amount', () => {
    const first = advanceConversationIntent(undefined, `${transfer}${then}${secondTransfer}300${currency}`, { now: () => 100 });
    expect(first.status).toBe('draft');
    expect(first.steps).toHaveLength(2);
    const clarified = advanceConversationIntent(first, `200${currency}`, { now: () => 200 });
    expect(clarified.id).toBe(first.id);
    expect(clarified.revision).toBe(2);
    expect(clarified.status).toBe('ready');
    expect(clarified.steps.map(step => step.amount)).toEqual(['200', '300']);
    expect(clarified.turns).toHaveLength(2);
  });

  it('resolves an explicit recipient and same-amount reference from trusted prior user intent', () => {
    const first = advanceConversationIntent(undefined, `${transfer}200${currency}`);
    const followup = '\u518d\u7ed9\u4ed6\u8f6c\u540c\u6837\u91d1\u989d';
    const second = advanceConversationIntent(first, `${followup}${then}${secondTransfer}300${currency}`);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('ready');
    expect(second.steps.map(step => [step.recipient, step.amount])).toEqual([
      ['\u5f20\u4f1f', '200'], ['\u738b\u82b3', '300'],
    ]);
  });

  it('does not guess which amount a clarification belongs to when two steps are incomplete', () => {
    const first = advanceConversationIntent(undefined, `${transfer}${then}${secondTransfer}`);
    const second = advanceConversationIntent(first, `200${currency}`);
    expect(second.status).toBe('draft');
    expect(second.requestText).toBe(first.requestText);
  });

  it('binds an explicit recipient clarification without inventing a new business step', () => {
    const first = advanceConversationIntent(undefined, `\u8f6c\u8d26\u0032\u0030\u0030${currency}`);
    const second = advanceConversationIntent(first, '\u5f20\u4f1f');
    expect(second.status).toBe('ready');
    expect(second.id).toBe(first.id);
    expect(second.steps).toHaveLength(1);
    expect(second.steps[0].recipient).toBe('\u5f20\u4f1f');
    expect(second.steps[0].amount).toBe('200');
  });

  it('drops a draft operation when the user explicitly abandons it', () => {
    const first = advanceConversationIntent(undefined, transfer);
    const second = advanceConversationIntent(first, '\u4e0d\u8f6c\u4e86\uff0c\u53d6\u6d88');
    expect(second.id).not.toBe(first.id);
    expect(second.steps).toHaveLength(0);
  });
});
