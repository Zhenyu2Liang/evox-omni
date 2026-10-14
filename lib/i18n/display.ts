import sources from './messages/display-sources.json';
import { isMessageKey, type Translator } from './shared';

/** Translate known display metadata only. Unknown and user-authored strings pass through. */
function lookup(source: Record<string, string>, value: string, t: Translator): string {
  const key = Object.hasOwn(source, value) ? source[value] : undefined;
  return key && isMessageKey(key) ? t(key) : value;
}

/** Preserve recorded error state and translate only known client transport messages at render. */
export function localizeChatError(message: string | undefined, t: Translator): string | undefined {
  if (message === undefined) return undefined;
  const exact = lookup(sources.errors, message, t);
  if (exact !== message) return exact;
  // This is the client's exact fixed HTTP-error template, never a free-form replacement.
  const status = /^\u8bf7\u6c42\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\uff08([1-5]\d{2})\uff09$/.exec(message);
  return status ? t('chat.error.requestStatus', { status: status[1] }) : exact;
}

export function localizeActionTitle(title: string, t: Translator): string {
  return lookup(sources.titles, title, t);
}

export function localizeActionFieldLabel(label: string, t: Translator): string {
  return lookup(sources.fields, label, t);
}

/** Only closed, server-defined policy fields have translated values. Facts are never rewritten. */
export function localizeActionFieldValue(field: { label: string; value: string }, t: Translator): string {
  const labelKey = sources.fields[field.label as keyof typeof sources.fields];
  if (labelKey === 'chat.field.risk') return lookup(sources.riskValues, field.value, t);
  if (labelKey === 'chat.field.operation') return localizeActionTitle(field.value, t);
  if (['chat.field.redemptionScope', 'chat.field.amountChange', 'chat.field.monthlyLimit',
    'chat.field.demoScope', 'chat.field.reminder'].includes(labelKey)) {
    return lookup(sources.policyValues, field.value, t);
  }
  return field.value;
}

export function isActionAmountField(label: string): boolean {
  return sources.fields[label as keyof typeof sources.fields] === 'cards.amount';
}

export function localizeVerificationHint(hint: string, t: Translator): string {
  return lookup(sources.hints, hint, t);
}

export function localizeToolLabel(label: string, t: Translator): string {
  const key = `chat.tool.${label}`;
  if (isMessageKey(key)) return t(key);
  return lookup(sources.tools, label, t);
}
