/**
 * ledger-keys.test.ts — PURE (no DB, no LLM) unit spec for the DE-DUP SCOPE identity helpers
 * of `@/lib/ledger`:
 *
 *  - `nodeExecutionKey(taskId, nodeId)`   → frozen `nxe:<taskId>:<nodeId>` plan-node side-effect key.
 *  - `idempotentTransferTxId(userId, key)`→ frozen `txidem_` + first 32 hex chars of
 *                                            `sha256("<userId>\u0000<key>")`.
 *
 * The point of these keys is DEDUPE IDENTITY: identical inputs must always yield identical keys
 * (so a repeat replays instead of double-applying), while the SCOPE must be exact — different
 * plans (`taskId`) or different nodes (`nodeId`) or different owners/keys must never be merged.
 * Both functions are deterministic and pure, so this spec needs no test DB and no model.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { idempotentTransferTxId, nodeExecutionKey } from '@/lib/ledger';

/** Reference implementation of the FROZEN sha256 id format, computed independently. */
function expectedTransferTxId(userId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${userId}\u0000${idempotencyKey}`).digest('hex');
  return `txidem_${digest.slice(0, 32)}`;
}

describe('nodeExecutionKey — plan-node side-effect de-dup scope', () => {
  it('produces the frozen `nxe:<taskId>:<nodeId>` format', () => {
    expect(nodeExecutionKey('task_1', 'n1')).toBe('nxe:task_1:n1');
  });

  it('is deterministic — identical args always yield the identical key', () => {
    expect(nodeExecutionKey('task_1', 'n1')).toBe(nodeExecutionKey('task_1', 'n1'));
    expect(nodeExecutionKey('task_9', 'check')).toBe(nodeExecutionKey('task_9', 'check'));
  });

  it('isolates plans — a different taskId with the same nodeId yields a different key', () => {
    expect(nodeExecutionKey('task_A', 'n1')).not.toBe(nodeExecutionKey('task_B', 'n1'));
  });

  it('isolates nodes — a different nodeId with the same taskId yields a different key', () => {
    expect(nodeExecutionKey('task_1', 'n1')).not.toBe(nodeExecutionKey('task_1', 'n2'));
  });

  it('is stable across repeated calls for the same (taskId, nodeId) pair', () => {
    const first = nodeExecutionKey('task_plan_42', 'node_check_limit');
    for (let i = 0; i < 5; i += 1) {
      expect(nodeExecutionKey('task_plan_42', 'node_check_limit')).toBe(first);
    }
  });
});

describe('idempotentTransferTxId — transfer-ledger de-dup scope', () => {
  it('is deterministic — the same (userId, key) always yields the same id', () => {
    expect(idempotentTransferTxId('user_liming', 'act_123')).toBe(
      idempotentTransferTxId('user_liming', 'act_123'),
    );
  });

  it('matches the frozen sha256 format and the `txidem_` + 32 hex pattern', () => {
    const actual = idempotentTransferTxId('user_liming', 'act_123');
    expect(actual).toBe(expectedTransferTxId('user_liming', 'act_123'));
    expect(actual).toMatch(/^txidem_[0-9a-f]{32}$/);
  });

  it('isolates owners — a different userId with the same key yields a different id', () => {
    expect(idempotentTransferTxId('user_liming', 'act_123')).not.toBe(
      idempotentTransferTxId('user_other', 'act_123'),
    );
  });

  it('isolates keys — a different idempotencyKey with the same userId yields a different id', () => {
    expect(idempotentTransferTxId('user_liming', 'act_123')).not.toBe(
      idempotentTransferTxId('user_liming', 'act_456'),
    );
  });

  it('is stable across repeated calls for the same (userId, key) pair', () => {
    const first = idempotentTransferTxId('user_liming', 'act_replay_me');
    for (let i = 0; i < 5; i += 1) {
      expect(idempotentTransferTxId('user_liming', 'act_replay_me')).toBe(first);
    }
  });
});

describe('de-dup namespaces never collide', () => {
  it('node keys live under `nxe:` and transfer tx ids under `txidem_`', () => {
    const nodeKey = nodeExecutionKey('task_1', 'n1');
    const transferTxId = idempotentTransferTxId('user_liming', 'act_123');

    expect(nodeKey.startsWith('nxe:')).toBe(true);
    expect(transferTxId.startsWith('txidem_')).toBe(true);
    expect(nodeKey).not.toBe(transferTxId);
    expect(nodeKey.startsWith('txidem_')).toBe(false);
    expect(transferTxId.startsWith('nxe:')).toBe(false);
  });
});
