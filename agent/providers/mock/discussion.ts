import type { Message } from '@earendil-works/pi-ai';
import { addMoney, formatCNY, moneyToCents } from '@/lib/money';
import messagesText from './messages.zh-CN.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Offline recommendations use prior structured query results without proposing a cancellation. */
export function subscriptionDiscussion(text: string, messages: readonly Message[]): string | undefined {
  if (!/(?:\u5206\u6790|\u5efa\u8bae|\u63a8\u8350|\u7701\u94b1)|\b(?:analyze|analysis|recommend|advice)\b/i.test(text)) return;
  for (const message of [...messages].reverse()) {
    if (message.role !== 'toolResult' || message.toolName !== 'list_subscriptions' || message.isError) continue;
    const data = isRecord(message.details) && 'data' in message.details ? message.details.data : message.details;
    if (!Array.isArray(data)) continue;
    const monthly = data.filter((row): row is { name: string; amount: string; cycle: string } =>
      isRecord(row) && typeof row.name === 'string' && typeof row.amount === 'string' && row.cycle === 'MONTHLY');
    if (monthly.length === 0) return;
    let total = '0.00';
    let largest = monthly[0];
    try {
      for (const row of monthly) {
        total = addMoney(total, row.amount);
        if (moneyToCents(row.amount) > moneyToCents(largest.amount)) largest = row;
      }
    } catch { return; }
    return messagesText.subscriptionAnalysis.replace('{total}', formatCNY(total))
      .replace('{name}', largest.name).replace('{amount}', formatCNY(largest.amount));
  }
}
