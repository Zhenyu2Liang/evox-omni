import { describe, expect, it } from 'vitest';
import { createTranslator, translate } from '@/lib/i18n/shared';
import { publicScheduleText } from '@/app/schedules/public-task-text';

const t = createTranslator('zh-CN');
const dispatchFallback = translate('zh-CN', 'tasks.schedules.dispatchFailed');
const loadFallback = translate('zh-CN', 'tasks.schedules.loadFailed');
const requestFallback = translate('zh-CN', 'tasks.schedules.requestFailed');

const LEAK_PATTERNS: Array<[string, RegExp | string]> = [
  ['security block marker', '__SECURITY_BLOCK__'],
  ['refusal payload field', 'decisionKind'],
  ['stack frame', /\n\s+at\s/],
  ['exception header', /[A-Za-z]*Error:/],
  ['object coercion', '[object Object]'],
];

function expectClean(rendered: string) {
  expect(rendered.length).toBeGreaterThan(0);
  for (const [label, pattern] of LEAK_PATTERNS) {
    if (typeof pattern === 'string') expect(rendered, `${label} leaked`).not.toContain(pattern);
    else expect(rendered, `${label} leaked`).not.toMatch(pattern);
  }
}

describe('publicScheduleText — internal diagnostics become catalog fallbacks', () => {
  it('replaces a serialized security refusal with the fallback catalog text', () => {
    const rendered = publicScheduleText('__SECURITY_BLOCK__{"decisionKind":"deny"}', t, 'tasks.schedules.dispatchFailed');
    expect(rendered).toBe(dispatchFallback);
    expect(rendered).not.toContain('__SECURITY_BLOCK__');
    expect(rendered).not.toContain('decisionKind');
    expectClean(rendered);
  });

  it('replaces a stack trace with the fallback catalog text', () => {
    const rendered = publicScheduleText('Error: boom\n    at Object.<anonymous> (/repo/x.ts:1:1)', t, 'tasks.schedules.dispatchFailed');
    expect(rendered).toBe(dispatchFallback);
    expectClean(rendered);
  });

  it.each(['undefined', 'null', '[object Object]', '{"a":1}', '{"message":"internal"}'])(
    'replaces the rendered-nothing shape %j with the fallback catalog text', shape => {
      const rendered = publicScheduleText(shape, t, 'tasks.schedules.requestFailed');
      expect(rendered).toBe(requestFallback);
      expect(rendered).not.toBe(shape);
      expectClean(rendered);
    });

  it.each([undefined, null, '', '   ', '\n\t '])('replaces the blank value %j with the fallback', blank => {
    expect(publicScheduleText(blank, t, 'tasks.schedules.loadFailed')).toBe(loadFallback);
  });
});

describe('publicScheduleText — legitimate business text survives', () => {
  it('returns business prose unchanged instead of over-sanitizing it', () => {
    const prose = '付款流程未创建：账户不可用';
    expect(publicScheduleText(prose, t, 'tasks.schedules.dispatchFailed')).toBe(prose);
  });

  it('keeps a dispatch error written in plain language', () => {
    const prose = '提醒未送达：联系人不存在';
    expect(publicScheduleText(prose, t, 'tasks.schedules.dispatchFailed')).toBe(prose);
  });
});

describe('publicScheduleText — message keys from the server are localized', () => {
  it('localizes a message key itself rather than showing the literal key', () => {
    const rendered = publicScheduleText('tasks.schedules.dispatchFailed', t, 'tasks.schedules.loadFailed');
    expect(rendered).toBe(dispatchFallback);
    expect(rendered).not.toBe('tasks.schedules.dispatchFailed');
    expectClean(rendered);
  });

  it('localizes whichever key the server returned, independent of the fallback', () => {
    expect(publicScheduleText('tasks.schedules.loadFailed', t, 'tasks.schedules.dispatchFailed')).toBe(loadFallback);
    expect(publicScheduleText('tasks.schedules.requestFailed', t, 'tasks.schedules.dispatchFailed')).toBe(requestFallback);
  });

  it('renders the English catalog when the page language is English', () => {
    const english = createTranslator('en');
    const rendered = publicScheduleText('__SECURITY_BLOCK__{"decisionKind":"deny"}', english, 'tasks.schedules.dispatchFailed');
    expect(rendered).toBe(translate('en', 'tasks.schedules.dispatchFailed'));
    expectClean(rendered);
  });
});

describe('publicScheduleText — every rendered result is clean', () => {
  it.each([
    ['__SECURITY_BLOCK__{"decisionKind":"deny"}', 'tasks.schedules.dispatchFailed'],
    ['Error: boom\n    at f (/repo/x.ts:1:1)', 'tasks.schedules.dispatchFailed'],
    ['undefined', 'tasks.schedules.loadFailed'],
    ['[object Object]', 'tasks.schedules.loadFailed'],
    ['{"a":1}', 'tasks.schedules.requestFailed'],
    ['', 'tasks.schedules.dispatchFailed'],
    ['tasks.schedules.emptyNotifications', 'tasks.schedules.dispatchFailed'],
    ['付款流程未创建：账户不可用', 'tasks.schedules.dispatchFailed'],
  ] as const)('%j → clean text under fallback %s', (text, fallback) => {
    expectClean(publicScheduleText(text, t, fallback));
  });
});