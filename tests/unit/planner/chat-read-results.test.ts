import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HoldingView, SubscriptionView, TransactionView } from '@/banking-sdk';
import { SubscriptionsCard } from '@/components/chat/cards/SubscriptionsCard';
import { TransactionsCard } from '@/components/chat/cards/TransactionsCard';
import { InvestmentsCard } from '@/components/chat/cards/InvestmentsCard';
import business from '@/lib/i18n/messages/business.zh-CN.json';
import { DEFAULT_LOCALE, translate } from '@/lib/i18n/shared';

describe('chat business result cards', () => {
  it('retains exact subscription prices and active billing facts without exposing database identifiers', () => {
    const subscriptions: SubscriptionView[] = [{
      id: 'private-subscription-id', name: 'Precision subscription', amount: '92233720368547758.07',
      cycle: 'YEARLY', nextChargeAt: 1_800_000_000_000, status: 'ACTIVE', remind: true,
    }];
    const markup = renderToStaticMarkup(createElement(SubscriptionsCard, { data: subscriptions }));
    expect(markup).toContain('Precision subscription');
    expect(markup).toContain('92,233,720,368,547,758.07');
    expect(markup).toContain(business['business.subscriptions.yearly']);
    expect(markup).toContain(business['business.subscriptions.active']);
    expect(markup).toContain(business['business.subscriptions.nextCharge']);
    expect(markup).toContain(business['business.subscriptions.reminderOn']);
    expect(markup).not.toContain('private-subscription-id');
  });

  it('does not advertise another debit for a cancelled subscription', () => {
    const subscription: SubscriptionView = {
      id: 'cancelled-id', name: 'Cancelled service', amount: '12.80', cycle: 'MONTHLY',
      nextChargeAt: 1_800_000_000_000, status: 'CANCELLED', remind: false,
    };
    const markup = renderToStaticMarkup(createElement(SubscriptionsCard, { data: [subscription] }));
    expect(markup).toContain(business['business.subscriptions.cancelled']);
    expect(markup).toContain('12.80');
    expect(markup).not.toContain(business['business.subscriptions.nextCharge']);
    expect(markup).toContain(business['business.subscriptions.reminderOff']);
  });

  it('shows signed transaction cents while keeping record and account identifiers out of normal content', () => {
    const transactions: TransactionView[] = [{
      id: 'internal-transaction-id', accountId: 'internal-account-id', amount: '-0.07', currency: 'CNY',
      direction: 'DEBIT', category: 'Shopping', merchant: 'Small purchase', occurredAt: 0, isAnomaly: false,
    }, {
      id: 'internal-credit-id', accountId: 'internal-account-id', amount: '92233720368547758.07', currency: 'CNY',
      direction: 'CREDIT', category: 'Income', merchant: 'Payment received', occurredAt: 0, isAnomaly: false,
    }];
    const markup = renderToStaticMarkup(createElement(TransactionsCard, { data: transactions }));
    expect(markup).toContain('-¥0.07');
    expect(markup).toContain('+¥92,233,720,368,547,758.07');
    expect(markup).toContain('Small purchase');
    expect(markup).not.toContain('internal-transaction-id');
    expect(markup).not.toContain('internal-account-id');
  });

  it('excludes redeemed holdings from live asset totals and retains their historical holding status', () => {
    const holdings: HoldingView[] = ['HOLDING', 'REDEEMED'].map((status, index) => ({
      id: `holding-${index}`, productId: `product-${index}`, productName: `Product ${index}`, riskLevel: 'R1',
      amount: '1000.00', marketValue: '1000.00456789', profit: '0.00456789', boughtAt: 0,
      status: status as HoldingView['status'],
      product: { id: `product-${index}`, name: `Product ${index}`, code: `CODE-${index}`, riskLevel: 'R1',
        annualYieldRate: '0.032575', termDays: 30, minAmount: '100.00' },
    }));
    const markup = renderToStaticMarkup(createElement(InvestmentsCard, { data: { holdings } }));
    expect(markup).toContain('1,000.00456789');
    expect(markup).toContain('3.2575%');
    expect(markup).toContain(business['business.investments.holdingActive']);
    expect(markup).toContain(business['business.investments.holdingRedeemed']);
    expect(markup).not.toContain('2,000.00');
    expect(markup).not.toContain('2,000.00913578');
  });

  it('does not turn partial estimates into an invented aggregate market value or profit', () => {
    const holdings: HoldingView[] = ['known', 'unknown'].map((id, index) => ({
      id, productId: id, productName: id, riskLevel: 'R1', amount: '1000.00', boughtAt: 0, status: 'HOLDING',
      ...(index === 0 ? { marketValue: '1000.00456789', profit: '0.00456789' } : {}),
      product: { id, name: id, code: id, riskLevel: 'R1', annualYieldRate: '0.032575', termDays: 30, minAmount: '100.00' },
    }));
    const markup = renderToStaticMarkup(createElement(InvestmentsCard, { data: { holdings } }));
    expect(markup).toContain('2,000.00');
    expect(markup).toContain('1,000.00456789');
    expect(markup).not.toContain('2,000.00456789');
    expect(markup).not.toContain(translate(DEFAULT_LOCALE, 'cards.investment.marketValue'));
    expect(markup).not.toContain(translate(DEFAULT_LOCALE, 'cards.investment.profit'));
  });
});
