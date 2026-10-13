import type { ConversationIntent, IntentStep } from '@/lib/contracts/intent';
import { demoNow } from '@/lib/clock';
import { newId } from '@/lib/ids';
import { requestedSteps } from '@/lib/request-steps';
import { requestedConditions } from '@/lib/request-conditions';

export interface IntentContextOptions {
  now?: () => number;
  id?: string;
}

const AMOUNT_PATTERN = /(?:[¥￥]\s*(\d+(?:\.\d+)?))|(?:(\d+(?:\.\d+)?)\s*(万)?\s*元)/g;

function requestedAmount(text: string): string | undefined {
  const matches = [...text.matchAll(AMOUNT_PATTERN)];
  if (matches.length === 0) {
    return /(?:转(?:账)?|预留|调成|调整到|设置为|设成|限额(?:为|到|是))\s*(\d+(?:\.\d+)?)/.exec(text)?.[1]
      ?? /^\s*(\d+(?:\.\d+)?)\s*$/.exec(text)?.[1];
  }
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const amount = match[1] ?? match[2];
  if (!match[3]) return amount;
  const [integer, fraction = ''] = amount.split('.');
  const digits = `${integer}${fraction}`;
  const zeros = 4 - fraction.length;
  return zeros >= 0 ? `${digits}${'0'.repeat(zeros)}` : `${digits.slice(0, zeros)}.${digits.slice(zeros)}`;
}

function requestedRecipient(text: string): string | undefined {
  const beforeVerb = /给\s*([^，,。；;\s]{1,30}?)\s*转(?:账)?/.exec(text)?.[1];
  const afterVerb = /转给\s*([^，,。；;\s\d]{1,30})/.exec(text)?.[1];
  const recipient = beforeVerb ?? afterVerb;
  return recipient && !/^(?:他|她|对方|这个人|那个人)$/.test(recipient) ? recipient : undefined;
}

function resolveReferences(text: string, reference: ConversationIntent['reference']): string {
  let resolved = text;
  if (reference.recipient) {
    resolved = resolved.replace(/(给|转给)\s*(?:他|她|对方|这个人|那个人)(?=\s*(?:转|[\d¥￥]))/g,
      (_match, prefix: string) => `${prefix}${reference.recipient}`);
  }
  if (reference.amount) {
    resolved = resolved.replace(/(?:同样(?:的)?金额|相同(?:的)?金额|同样多|一样多)/g, reference.amount);
  }
  return resolved;
}

function intentSteps(requestText: string): IntentStep[] {
  return requestedSteps(requestText).map((step, index) => {
    const amount = requestedAmount(step.span);
    const recipient = step.tool === 'transfer_money' ? requestedRecipient(step.span) : undefined;
    const needsAmount = ['transfer_money', 'subscribe_investment', 'reserve_budget', 'set_card_limit'].includes(step.tool);
    const unresolvedReference = /(?:给|转给)\s*(?:他|她|对方|这个人|那个人)(?=\s*(?:转|[\d¥￥]))|同样(?:的)?金额|相同(?:的)?金额/.test(step.span);
    return {
      key: `step-${index + 1}`,
      tool: step.tool,
      sourceText: step.span,
      requestText: step.span,
      amount,
      recipient,
      requiresClarification: unresolvedReference || (needsAmount && !amount) || (step.tool === 'transfer_money' && !recipient),
    };
  });
}

/** Resolve only explicit user references; model text is never an intent input. */
export function advanceConversationIntent(
  previous: ConversationIntent | undefined,
  message: string,
  options: IntentContextOptions = {},
): ConversationIntent {
  const timestamp = (options.now ?? demoNow)();
  const reference = previous?.reference ?? {};
  let requestText = resolveReferences(message, reference);
  let continuing = false;
  const explicitSteps = requestedSteps(requestText);

  if (previous?.status === 'draft' && explicitSteps.length === 0 && !/(?:取消|不要|不用|不必|无需|停止|放弃)/.test(message)) {
    const missingAmounts = previous.steps.filter(step => step.requiresClarification && !step.amount);
    const amount = requestedAmount(message);
    if (amount && missingAmounts.length === 1) {
      const target = missingAmounts[0];
      requestText = previous.requestText.replace(target.requestText, `${target.requestText} ${message}`);
      continuing = true;
    } else if (!amount && previous.steps.filter(step => step.tool === 'transfer_money' && !step.recipient).length === 1
      && /^[\p{L}\d\s]{1,30}$/u.test(message)) {
      const target = previous.steps.find(step => step.tool === 'transfer_money' && !step.recipient)!;
      const resolvedStep = target.requestText.replace(/(?:给\s*(?:他|她|对方)?\s*)?转(?:账)?/,
        match => match.replace(/(?:给\s*(?:他|她|对方)?\s*)?转/, `\u7ed9${message.trim()}\u8f6c`));
      requestText = previous.requestText.replace(target.requestText, resolvedStep);
      continuing = true;
    } else {
      requestText = previous.requestText;
      continuing = true;
    }
  }

  const steps = intentSteps(requestText);
  const transferReference = [...steps].reverse().find(step => step.tool === 'transfer_money' && step.recipient && step.amount);
  const nextReference = transferReference
    ? { recipient: transferReference.recipient, amount: transferReference.amount }
    : reference;
  const revision = continuing ? previous!.revision + 1 : 1;
  return {
    id: continuing ? previous!.id : options.id ?? newId('intent'),
    revision,
    status: steps.some(step => step.requiresClarification) ? 'draft' : 'ready',
    requestText,
    latestMessage: message,
    turns: continuing
      ? [...previous!.turns, { revision, text: message, receivedAt: timestamp }]
      : [{ revision, text: message, receivedAt: timestamp }],
    steps,
    conditions: requestedConditions(requestText),
    reference: nextReference,
    createdAt: continuing ? previous!.createdAt : timestamp,
    updatedAt: timestamp,
  };
}

export function intentRequestText(intent: ConversationIntent | undefined, fallback = ''): string {
  return intent?.requestText ?? fallback;
}
