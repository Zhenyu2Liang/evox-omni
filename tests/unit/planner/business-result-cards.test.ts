import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { toCards } from '@/agent/card-emitter';
import type { ChatCard } from '@/lib/contracts/agent';
import type { ToolName } from '@/lib/contracts/tools';
import { CardRenderer } from '@/components/chat/cards/CardRenderer';
import { LocaleProvider } from '@/lib/i18n/LocaleProvider';
import { translate } from '@/lib/i18n/shared';
import { formatCNY } from '@/lib/money';
import { formatDecimalCNY } from '@/lib/decimal';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const NOW = Date.UTC(2026, 9, 14, 8);
const LARGE_AMOUNT = '92233720368547758.07';

function render(card: ChatCard): string {
  return renderToStaticMarkup(createElement(CardRenderer, { card }));
}

describe('business evidence cards', () => {
  it.each(['search_contact', 'list_scheduled_tasks'] as const)('keeps empty %s query results visible', tool => {
    const [card] = toCards(tool, { ok: true, data: [] });
    expect(card.type).toBe(tool === 'search_contact' ? 'contacts' : 'scheduled');
    const emptyKey = tool === 'search_contact' ? 'business.contacts.empty' : 'business.scheduled.empty';
    expect(render(card)).toContain(translate('zh-CN', emptyKey));
  });

  it('a failed invocation cannot produce a success receipt from attached data', () => {
    const [card] = toCards('subscribe_investment', { ok: false, data: { success: true, amount: '200.00', newBalance: '800.00', occurredAt: NOW } });
    expect(card.type).toBe('error');
    const markup = render(card);
    expect(markup).toContain(translate('zh-CN', 'business.results.failed'));
    expect(markup).not.toContain('200.00');
  });

  it('presents contacts without exposing internal IDs, credentials or full phone numbers', () => {
    const [card] = toCards('search_contact', { ok: true, data: [{ id: 'internal-contact', name: 'Ada',
      phone: '13800000000', bank: 'Demo Bank', remark: 'Family', password: 'secret-value' }] });
    expect(card).toEqual({ type: 'contacts', data: [{ name: 'Ada', phone: '13800000000', bank: 'Demo Bank', remark: 'Family' }] });
    const markup = render(card);
    expect(markup).toContain('Ada');
    expect(markup).toContain('138****0000');
    expect(markup).not.toContain('13800000000');
    expect(markup).not.toContain('internal-contact');
    expect(markup).not.toContain('secret-value');
    expect(markup).not.toContain('search_contact');
  });

  it('keeps booked money and unrounded asset valuation exact while excluding unrelated raw dashboard fields', () => {
    const valuation = '92233720368547758.071234567890123456';
    const [card] = toCards('get_dashboard_summary', { ok: true, data: {
      totalAssets: valuation, checkingBalance: LARGE_AMOUNT, creditAvailable: '100.00', monthSpend: '0.07',
      month: '2026-10', asOf: NOW, recentTransactions: [{ privateDetails: 'unwanted' }], latestAnomaly: { secret: 'unwanted' },
    } });
    expect(card.type).toBe('dashboard');
    const markup = render(card);
    expect(markup).toContain(formatCNY(LARGE_AMOUNT));
    expect(markup).toContain(formatDecimalCNY(valuation));
    expect(markup).not.toContain('unwanted');
    expect(markup).not.toContain('get_dashboard_summary');
  });

  it('distinguishes creating a schedule from posting a payment and strips the future payload', () => {
    const [card] = toCards('create_scheduled_task', { ok: true, data: { name: 'Rent', kind: 'TRANSFER', status: 'DONE',
      runAt: NOW, requiresConfirmation: true, id: 'private-schedule', payload: { amount: LARGE_AMOUNT, token: 'private-token' },
      dispatchError: 'raw-diagnostic', dispatchTaskId: 'private-task' } });
    expect(card).toEqual({ type: 'scheduled', created: true, data: [{ name: 'Rent', kind: 'TRANSFER', status: 'DONE', runAt: NOW, requiresConfirmation: true }] });
    const markup = render(card);
    expect(markup).toContain(translate('zh-CN', 'business.scheduled.status.DONE'));
    expect(markup).toContain(translate('zh-CN', 'business.scheduled.scope'));
    expect(markup).not.toContain('private-');
    expect(markup).not.toContain('raw-diagnostic');
    expect(markup).not.toContain(LARGE_AMOUNT);
  });

  it('shows a budget envelope without claiming the reservation debited or froze the account', () => {
    const [card] = toCards('reserve_budget', { ok: true, data: { name: 'Travel', amount: LARGE_AMOUNT, status: 'RESERVED', purpose: 'Holiday', dueDate: NOW } });
    expect(card.type).toBe('receipt');
    const markup = render(card);
    expect(markup).toContain(formatCNY(LARGE_AMOUNT));
    expect(markup).toContain(translate('zh-CN', 'business.receipt.budgetScope'));
    expect(markup).not.toContain('reserve_budget');
  });

  it('renders actual investment receipt values without inventing a product name or leaking account IDs', () => {
    const [card] = toCards('redeem_investment', { ok: true, data: { success: true, holdingId: 'private-holding',
      productId: 'private-product', sourceAccountId: 'private-account', amount: LARGE_AMOUNT, newBalance: '0.07',
      occurredAt: NOW, redemptionValuation: '92233720368547758.071', settlementRounding: 'HALF_UP' } });
    const markup = render(card);
    expect(markup).toContain(formatCNY(LARGE_AMOUNT));
    expect(markup).toContain(formatCNY('0.07'));
    expect(markup).toContain(formatDecimalCNY('92233720368547758.071'));
    expect(markup).not.toContain('private-');
    expect(markup).not.toContain('redeem_investment');
  });

  it.each([
    ['get_dashboard_summary', { totalAssets: 0.1, checkingBalance: '0.10', creditAvailable: '0.00', monthSpend: '0.00', month: '2026-10', asOf: NOW }],
    ['get_dashboard_summary', { totalAssets: '0.1', checkingBalance: '0.001', creditAvailable: '0.00', monthSpend: '0.00', month: '2026-10', asOf: NOW }],
    ['reserve_budget', { name: 'Travel', amount: 0.1, status: 'RESERVED' }],
    ['create_scheduled_task', { name: 'Rent', kind: 'UNRECOGNIZED', status: 'DONE', runAt: NOW, requiresConfirmation: true }],
    ['list_scheduled_tasks', { name: 'Rent', kind: 'TRANSFER', status: 'FORGED_SUCCESS', runAt: NOW, requiresConfirmation: true }],
    ['subscribe_investment', { success: true, amount: '0.10', newBalance: '0.00', occurredAt: Infinity }],
    ['redeem_investment', { success: true, amount: '0.10', newBalance: '0.00', occurredAt: NOW, settlementRounding: 'UNRECOGNIZED' }],
  ] as const)('fails safely on malformed %s evidence instead of showing a forged result', (tool, data) => {
    const [card] = toCards(tool, { ok: true, data });
    expect(card.type).toBe('error');
    const markup = render(card);
    expect(markup).toContain(translate('zh-CN', 'business.results.invalid'));
    expect(markup).not.toContain(tool);
  });

  it('unknown tool diagnostics are absent from ordinary error cards', () => {
    const [card] = toCards('private_runtime_tool' as ToolName, { ok: true, data: {} });
    expect(card.type).toBe('error');
    expect(render(card)).not.toContain('private_runtime_tool');
  });

  it('supports English result labels without translating user-authored recipient names', () => {
    const [card] = toCards('search_contact', { ok: true, data: [{ name: 'Ada', phone: '13800000000' }] });
    const markup = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: 'en', children: createElement(CardRenderer, { card }) }));
    expect(markup).toContain('Matching recipients');
    expect(markup).toContain('Ada');
  });

  it('treats recipient names and remarks as literal text rather than executable markup', () => {
    const [card] = toCards('search_contact', { ok: true, data: [{ name: '<script>unsafe()</script>', phone: '13800000000', remark: '<img src="private-url">' }] });
    const markup = render(card);
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img');
  });
});
