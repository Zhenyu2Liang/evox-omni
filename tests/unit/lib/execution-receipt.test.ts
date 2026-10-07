/**
 * execution-receipt.test.ts — PURE (no DB, no LLM) unit spec for the COMMITTED-FACT helpers of
 * `@/lib/ledger`:
 *
 *  - `executionReceiptId(userId, key)` → deterministic `rcpt_` + first 32 hex chars of
 *                                        `sha256("<userId>\u0000<key>")`.
 *  - `requestDigest(parts)`            → stable sha256 hex of the KEY-SORTED, canonical JSON of the
 *                                        request parts (key INSERTION ORDER never changes the digest).
 *
 * Both are deterministic and pure, so this spec needs no test DB and no model.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executionReceiptId, idempotentTransferTxId, requestDigest } from '@/lib/ledger';

/** Reference implementation of the FROZEN sha256 receipt id format, computed independently. */
function expectedReceiptId(userId: string, key: string): string {
  const digest = createHash('sha256').update(`${userId}\u0000${key}`).digest('hex');
  return `rcpt_${digest.slice(0, 32)}`;
}

/** Reference implementation of the canonical (key-sorted) JSON sha256 digest, computed independently. */
function expectedRequestDigest(parts: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(sort(parts))).digest('hex');
}

describe('executionReceiptId — committed-fact receipt identity', () => {
  it('is deterministic — the same (userId, key) always yields the same id', () => {
    expect(executionReceiptId('user_liming', 'act_123')).toBe(executionReceiptId('user_liming', 'act_123'));
  });

  it('matches the frozen sha256 format and the `rcpt_` + 32 hex pattern', () => {
    const actual = executionReceiptId('user_liming', 'act_123');
    expect(actual).toBe(expectedReceiptId('user_liming', 'act_123'));
    expect(actual).toMatch(/^rcpt_[0-9a-f]{32}$/);
  });

  it('isolates owners and keys', () => {
    expect(executionReceiptId('user_liming', 'act_123')).not.toBe(executionReceiptId('user_other', 'act_123'));
    expect(executionReceiptId('user_liming', 'act_123')).not.toBe(executionReceiptId('user_liming', 'act_456'));
  });
});

describe('requestDigest — canonical request fingerprint', () => {
  const base = { userId: 'user_liming', toolName: 'transfer_money', name: '张伟', amount: 200 };

  it('is deterministic and a lowercase hex sha256', () => {
    expect(requestDigest(base)).toBe(requestDigest(base));
    expect(requestDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestDigest(base)).toBe(expectedRequestDigest(base));
  });

  it('is INDEPENDENT of key insertion order', () => {
    const reordered = { amount: 200, name: '张伟', toolName: 'transfer_money', userId: 'user_liming' };
    expect(requestDigest(reordered)).toBe(requestDigest(base));
  });

  it('sorts NESTED object keys too', () => {
    const a = { outer: { b: 1, a: 2 }, top: true };
    const b = { top: true, outer: { a: 2, b: 1 } };
    expect(requestDigest(a)).toBe(requestDigest(b));
  });

  it('normalizes an absent `undefined` part the same as an explicit `null`', () => {
    expect(requestDigest({ amount: 200, remark: undefined })).toBe(requestDigest({ amount: 200, remark: null }));
  });

  it('changes when any request field changes (a different request is never the same identity)', () => {
    expect(requestDigest({ ...base, amount: 300 })).not.toBe(requestDigest(base));
    expect(requestDigest({ ...base, name: '王芳' })).not.toBe(requestDigest(base));
    expect(requestDigest({ ...base, remark: '房租' })).not.toBe(requestDigest(base));
    expect(requestDigest({ ...base, userId: 'user_other' })).not.toBe(requestDigest(base));
  });
});

describe('receipt + ledger namespaces never collide', () => {
  it('receipt ids live under `rcpt_` while transfer-ledger ids live under `txidem_`', () => {
    const receiptId = executionReceiptId('user_liming', 'act_123');
    const ledgerId = idempotentTransferTxId('user_liming', 'act_123');

    expect(receiptId.startsWith('rcpt_')).toBe(true);
    expect(ledgerId.startsWith('txidem_')).toBe(true);
    expect(receiptId).not.toBe(ledgerId);
    expect(receiptId.startsWith('txidem_')).toBe(false);
    expect(ledgerId.startsWith('rcpt_')).toBe(false);
  });
});
