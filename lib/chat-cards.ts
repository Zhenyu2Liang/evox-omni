import type { ChatCard } from './contracts/agent';

/** Replayed snapshots may reorder object keys; financial strings and list order stay exact. */
export function cardFingerprint(card: ChatCard): string {
  return JSON.stringify(card, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    }
    return value;
  });
}
