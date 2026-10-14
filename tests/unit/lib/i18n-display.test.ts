import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '@/lib/contracts/tool-catalog';
import {
  isActionAmountField, localizeActionFieldLabel, localizeActionFieldValue,
  localizeActionTitle, localizeChatError, localizeToolLabel, localizeVerificationHint,
} from '@/lib/i18n/display';
import { createTranslator, isMessageKey } from '@/lib/i18n/shared';
import english from '@/lib/i18n/messages/chat.en.json';
import chinese from '@/lib/i18n/messages/chat.zh-CN.json';
import sources from '@/lib/i18n/messages/display-sources.json';

const en = createTranslator('en');
const zh = createTranslator('zh-CN');

function sourceFor(group: Record<string, string>, key: string): string {
  const source = Object.keys(group).find(value => group[value] === key);
  if (!source) throw new Error(`Missing source fixture: ${key}`);
  return source;
}

describe('display-only metadata localization', () => {
  it('maps only existing catalog keys', () => {
    for (const group of Object.values(sources)) {
      for (const key of Object.values(group)) expect(isMessageKey(key), key).toBe(true);
    }
  });

  it('covers every current static authorization policy description', () => {
    for (const policy of Object.values(TOOL_CATALOG)) {
      const key = sources.titles[policy.description as keyof typeof sources.titles];
      expect(isMessageKey(key), policy.description).toBe(true);
      if (!isMessageKey(key)) throw new Error(`Missing policy translation: ${policy.description}`);
      expect(localizeActionTitle(policy.description, zh)).toBe(zh(key));
      expect(localizeActionTitle(policy.description, en)).toBe(en(key));
    }
  });

  it('localizes known transport errors without changing recorded state', () => {
    const original = 'The response stream was interrupted. Inspect the saved run before retrying.';
    expect(localizeChatError(original, zh)).toBe(chinese['chat.error.interruptedStream']);
    expect(localizeChatError(original, en)).toBe(english['chat.error.interruptedStream']);
    expect(original).toBe('The response stream was interrupted. Inspect the saved run before retrying.');
    expect(localizeChatError(undefined, zh)).toBeUndefined();
  });

  it('accepts only the exact client HTTP status error template', () => {
    const source = sourceFor(sources.errors, 'chat.error.request');
    expect(localizeChatError(`${source}\uff08503\uff09`, en)).toContain('HTTP 503');
    expect(localizeChatError(`${source}\uff08503\uff09 extra`, en)).toBe(`${source}\uff08503\uff09 extra`);
    expect(localizeChatError(`${source}\uff08invalid\uff09`, en)).toBe(`${source}\uff08invalid\uff09`);
  });

  it('preserves arbitrary errors and policy-title suffixes exactly', () => {
    const arbitrary = 'Recipient Alice / txn-42: balance 92233720368547758.07 is unavailable.';
    const extended = `${TOOL_CATALOG.freeze_card.description} User note: keep card-42.`;
    expect(localizeChatError(arbitrary, zh)).toBe(arbitrary);
    expect(localizeActionTitle(extended, zh)).toBe(extended);
    expect(localizeActionTitle('User-defined task', en)).toBe('User-defined task');
  });

  it('recognizes both current amount labels and does not match by prefix', () => {
    const originalLabel = sourceFor(sources.fields, 'cards.amount');
    expect(isActionAmountField(originalLabel)).toBe(true);
    expect(isActionAmountField('Amount')).toBe(true);
    expect(isActionAmountField('Amount due')).toBe(false);
    expect(isActionAmountField('constructor')).toBe(false);
    expect(localizeActionFieldLabel('Amount', zh)).toBe(chinese['cards.amount']);
  });

  it('preserves financial amounts and account names even when they resemble metadata', () => {
    const amount = '¥92,233,720,368,547,758.07';
    const accountLabel = sourceFor(sources.fields, 'chat.field.account');
    const name = TOOL_CATALOG.freeze_card.description;
    expect(localizeActionFieldValue({ label: 'Amount', value: amount }, zh)).toBe(amount);
    expect(localizeActionFieldValue({ label: accountLabel, value: name }, zh)).toBe(name);
    expect(localizeActionFieldValue({ label: 'Custom field', value: name }, en)).toBe(name);
    expect(localizeActionFieldLabel('Custom field', zh)).toBe('Custom field');
  });

  it('translates risk and operation values only in their closed metadata fields', () => {
    const riskLabel = sourceFor(sources.fields, 'chat.field.risk');
    const green = sourceFor(sources.riskValues, 'chat.risk.GREEN');
    const operationLabel = sourceFor(sources.fields, 'chat.field.operation');
    expect(localizeActionFieldValue({ label: riskLabel, value: green }, en)).toBe(english['chat.risk.GREEN']);
    expect(localizeActionFieldValue({ label: operationLabel, value: TOOL_CATALOG.transfer_money.description }, zh))
      .toBe(chinese['chat.policy.transfer_money']);
    expect(localizeActionFieldValue({ label: 'Custom field', value: green }, en)).toBe(green);
  });

  it('preserves redemption and demo limits in translated policy values', () => {
    const scopeLabel = sourceFor(sources.fields, 'chat.field.redemptionScope');
    const scopeValue = sourceFor(sources.policyValues, 'chat.value.fullRedemption');
    const demoLabel = sourceFor(sources.fields, 'chat.field.demoScope');
    const demoValue = sourceFor(sources.policyValues, 'chat.value.taskDemoScope');
    expect(localizeActionFieldValue({ label: scopeLabel, value: scopeValue }, en)).toContain('partial redemption is not supported');
    expect(localizeActionFieldValue({ label: demoLabel, value: demoValue }, en)).toContain('not guaranteed');
    expect(localizeActionFieldValue({ label: demoLabel, value: 'Custom limitation' }, zh)).toBe('Custom limitation');
  });

  it('translates known code-free hints and tool labels but preserves custom strings', () => {
    const demoHint = 'Enter the 6-digit demo verification code. No SMS is sent.';
    const toolLabel = sourceFor(sources.tools, 'chat.tool.get_balance');
    expect(localizeVerificationHint(demoHint, zh)).toBe(chinese['chat.display.demoHint']);
    expect(localizeVerificationHint('Custom provider verification guidance', zh)).toBe('Custom provider verification guidance');
    expect(localizeToolLabel(toolLabel, en)).toBe(english['chat.tool.get_balance']);
    expect(localizeToolLabel('get_balance', zh)).toBe(chinese['chat.tool.get_balance']);
    expect(localizeToolLabel('list_subscriptions', zh)).toBe(chinese['chat.tool.list_subscriptions']);
    expect(localizeToolLabel('list_subscriptions', en)).toBe(english['chat.tool.list_subscriptions']);
  });

  it('ignores object prototype properties in source lookups', () => {
    for (const value of ['constructor', 'toString', '__proto__']) {
      expect(localizeChatError(value, zh)).toBe(value);
      expect(localizeActionTitle(value, zh)).toBe(value);
      expect(localizeActionFieldLabel(value, zh)).toBe(value);
      expect(localizeVerificationHint(value, zh)).toBe(value);
      expect(localizeToolLabel(value, zh)).toBe(value);
    }
  });
});
