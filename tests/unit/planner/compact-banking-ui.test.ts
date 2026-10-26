import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { CardView, HoldingView } from '@/banking-sdk';
import { CardPrimaryAmount } from '@/components/banking/CardPrimaryAmount';
import { HoldingFacts } from '@/components/banking/HoldingFacts';
import { IssuedCardNumber } from '@/components/chat/cards/IssuedCardNumber';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { BusinessReceiptCard } from '@/components/chat/cards/BusinessResultCards';
import { ApprovalProgress } from '@/components/chat/cards/ApprovalProgress';
import { presentationMessages } from '@/components/chat/presentation-messages';
import { financialResponseSummary } from '@/agent/financial-response';
import { investmentPayload } from '@/agent/business-card-payloads';
import { isChatMessage } from '@/components/chat/transport-validation';

const holding: HoldingView = { id: 'holding-private', productId: 'prod', productName: '稳健理财A', riskLevel: 'R2',
  product: { id: 'prod', code: 'A01', name: '稳健理财A', riskLevel: 'R2', annualYieldRate: '0.03', termDays: 90, minAmount: '1000.00' },
  amount: '1000.00', shares: '1000', latestNetValue: '0.9880', latestNetValueDate: 1790265600000,
  marketValue: '988', profit: '-12', profitRate: '-0.012', realizedProfit: '10.00', cumulativeProfit: '-2',
  status: 'HOLDING', boughtAt: 0, valueBasis: 'NET_VALUE' };

describe('compact banking presentation', () => {
  it('keeps settlement and remaining units visible, with exact supporting values in closed details', () => {
    const payload = investmentPayload({ success: true, productName: '稳健理财A', amount: '1035.70', newBalance: '27437.04',
      occurredAt: 0, remainingShares: '1999.918895', redeemedShares: '1000', netValuePerUnit: '1.0357', feeAmount: '0.00' }, 'investmentRedemption');
    expect(payload).not.toBeNull();
    const html = renderToStaticMarkup(createElement(BusinessReceiptCard, { data: payload! }));
    const [primary, details] = html.split('<details');
    expect(primary).toContain('稳健理财A');
    expect(primary).toContain('¥1,035.70');
    expect(primary).toContain('1999.918895');
    expect(primary).not.toContain('27,437.04');
    expect(details).toContain('¥27,437.04');
    expect(details).toContain('1.0357');
    expect(details).not.toMatch(/^[^>]*\bopen\b/);
  });

  it('rejects malformed receipt quantities instead of displaying an invented figure', () => {
    expect(investmentPayload({ success: true, amount: '1.00', newBalance: '2.00', occurredAt: 0, remainingShares: 'not-a-number' }, 'investmentRedemption')).toBeNull();
  });

  it('shows market value and signed holding returns before secondary holding facts', () => {
    const primary = renderToStaticMarkup(createElement(HoldingFacts, { holding, layout: 'card', section: 'summary' }));
    const details = renderToStaticMarkup(createElement(HoldingFacts, { holding, layout: 'card', section: 'details' }));
    expect(primary).toContain('¥988.00');
    expect(primary).toContain('-¥12.00');
    expect(primary).toContain('-1.20%');
    expect(primary).not.toContain('最新净值');
    expect(details).toContain('0.9880');
    expect(details).toContain('1000.000000');
    expect(details).toContain('累计收益');
  });

  it.each(['DEBIT', 'CREDIT', 'VIRTUAL'] as const)('distinguishes the primary %s amount without computing money', type => {
    const card: CardView = { id: 'c', type, network: 'UnionPay', numberMasked: '****1234', status: 'ACTIVE', limits: [],
      usable: true, linkedAccountStatus: type === 'CREDIT' ? 'NOT_APPLICABLE' : 'LINKED',
      availableLimit: '18000.00', creditLimit: '20000.00', accountAvailableBalance: '23580.37', payableAmount: '4912.00' };
    const html = renderToStaticMarkup(createElement(CardPrimaryAmount, { card }));
    expect(html).toContain(type === 'CREDIT' ? '¥18,000.00' : type === 'VIRTUAL' ? '¥4,912.00' : '¥23,580.37');
    expect(html).not.toContain('20,000.00');
    if (type !== 'CREDIT') expect(renderToStaticMarkup(createElement(CardPrimaryAmount, { card: { ...card, linkedAccountStatus: 'UNTRUSTED' } }))).toBe('');
  });

  it('offers explicit reveal without including a full number in the initial markup', () => {
    const html = renderToStaticMarkup(createElement(IssuedCardNumber, { actionId: 'a', cardId: 'c' }));
    expect(html).toContain('查看卡号');
    expect(html).not.toContain('data-full-card-number');
    expect(html).not.toContain('复制卡号');
  });

  it('coalesces only the same approval and never mutates saved messages or suppresses other failures', () => {
    const action = { actionId: 'a', toolName: 'transfer_money' as const, title: 'Transfer', tier: 'RED' as const, requiresMfa: true, fields: [] };
    const messages: ChatMessage[] = [{ id: 'one', role: 'tool', content: '', timestamp: 0, cards: [{ type: 'confirmation', action }] },
      { id: 'two', role: 'tool', content: '', timestamp: 1, cards: [{ type: 'mfa', actionId: 'a', action, status: 'awaiting_mfa' }] },
      { id: 'three', role: 'tool', content: '', timestamp: 2, cards: [{ type: 'mfa', actionId: 'b', status: 'locked' }] }];
    const active = presentationMessages(messages, 'a');
    expect(active[0].cards).toHaveLength(0); expect(active[1].cards).toHaveLength(0);
    expect(active[2].cards).toEqual(messages[2].cards);
    const settled = presentationMessages(messages);
    expect(settled[0].cards).toHaveLength(0); expect(settled[1].cards).toHaveLength(1);
    expect(messages[0].cards).toHaveLength(1);
  });

  it('preserves a terminal record against later stale prompts and a stale active selection', () => {
    const messages: ChatMessage[] = [{ id: 'settled', role: 'tool', content: '', timestamp: 0,
      cards: [{ type: 'mfa', actionId: 'a', status: 'executed' }] },
    { id: 'stale', role: 'tool', content: '', timestamp: 1, cards: [{ type: 'mfa', actionId: 'a', status: 'awaiting_mfa' }] }];
    const result = presentationMessages(messages, 'a');
    expect(result[0].cards).toEqual(messages[0].cards);
    expect(result[1].cards).toHaveLength(0);
  });

  it('retains the original financial narrative in collapsed details and across transport validation', () => {
    const message: ChatMessage = { id: 'm', role: 'assistant', timestamp: 0, financialSummary: '理财赎回已完成，到账 ¥103.57。', content: '赎回份额 100 份；操作后余额 ¥24,683.57。' };
    expect(isChatMessage(message)).toBe(true);
    const html = renderToStaticMarkup(createElement(MessageBubble, { message }));
    expect(html.split('<details')[0]).toContain('¥103.57');
    expect(html.split('<details')[0]).not.toContain('24,683.57');
    expect(html).toContain('24,683.57');
    expect(isChatMessage({ ...message, financialSummary: 12 })).toBe(false);
  });

  it('combines settled approval progress and its receipt in one operation surface', () => {
    const message: ChatMessage = { id: 'm', role: 'tool', timestamp: 0, content: '', cards: [
      { type: 'mfa', actionId: 'a', status: 'executed' },
      { type: 'receipt', data: { kind: 'investmentRedemption', success: true, amount: '1.07', newBalance: '2.00', occurredAt: 0 } },
    ] };
    const html = renderToStaticMarkup(createElement(MessageBubble, { message }));
    expect(html.match(/data-operation-record=/g)).toHaveLength(1);
    expect(html).toContain('data-approval-progress');
    expect(html).toContain('¥1.07');
  });

  it('never collapses unknown or failed writes behind a success preview', () => {
    const success = { toolName: 'transfer_money', result: { ok: true, data: { amount: '0.07', newBalance: '1.00' } } };
    expect(financialResponseSummary([success])).toContain('¥0.07');
    expect(financialResponseSummary([{ ...success, result: { ok: false } }])).toBeUndefined();
    expect(financialResponseSummary([{ ...success, result: { ok: true, data: { status: 'needs_reconciliation' } } }])).toBeUndefined();
  });

  it('marks results only from the actual operation state', () => {
    expect(renderToStaticMarkup(createElement(ApprovalProgress, { status: 'awaiting_mfa', requiresMfa: true }))).toContain('data-current-step="2"');
    expect(renderToStaticMarkup(createElement(ApprovalProgress, { status: 'executed', requiresMfa: false }))).toContain('data-current-step="3"');
    expect(renderToStaticMarkup(createElement(ApprovalProgress, { status: 'confirmed', requiresMfa: true }))).toContain('data-current-step="3"');
  });
});
