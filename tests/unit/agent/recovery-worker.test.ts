import { describe, expect, it, vi } from 'vitest';
import { runAgentRecoveryWorker, tickAgentRecovery, type RecoveryWorkerPorts } from '@/agent/recovery-worker';
import { parseRecoveryArguments } from '@/scripts/agent-recovery';
import { AppError } from '@/lib/errors';
import type { RunRecoveryResponse } from '@/agent/durable/service';

vi.mock('@/agent/durable/service', () => ({ recoverOwnedRun: vi.fn(), getOwnedRunSummary: vi.fn() }));
vi.mock('@/lib/db/repositories/agentRun', () => ({ listRecoverableAgentRuns: vi.fn() }));

const first = { id: 'run-first', sessionId: 'session-first', userId: 'user-first' };
const second = { id: 'run-second', sessionId: 'session-second', userId: 'user-second' };

function ports(): RecoveryWorkerPorts {
  return { discover: vi.fn(async () => [first, second]),
    recover: vi.fn(async run => ({ run: { id: run.id, status: 'completed' }, outcomes: [], message: 'Recovered.' } as unknown as RunRecoveryResponse)) };
}

describe('agent recovery host worker', () => {
  it('keeps processing independent sessions when a foreground turn won a candidate lease', async () => {
    const recovery = ports();
    vi.mocked(recovery.recover).mockRejectedValueOnce(new AppError('CONFLICT', 'Lease already held.'));
    const result = await tickAgentRecovery({ ports: recovery, limit: 2 });
    expect(result).toEqual({ discovered: 2, outcomes: [
      { runId: first.id, status: 'busy', errorCode: 'CONFLICT' }, { runId: second.id, status: 'completed' },
    ] });
    expect(recovery.recover).toHaveBeenNthCalledWith(1, first);
    expect(recovery.recover).toHaveBeenNthCalledWith(2, second);
  });

  it('does not expose private executor exception text in tick diagnostics', async () => {
    const recovery = ports();
    vi.mocked(recovery.recover).mockRejectedValueOnce(new Error('Private model prompt and API key.'));
    const result = await tickAgentRecovery({ ports: recovery });
    expect(result.outcomes[0]).toEqual({ runId: first.id, status: 'failed', errorCode: 'INTERNAL' });
    expect(JSON.stringify(result)).not.toContain('Private');
  });

  it('reports a terminal checkpoint conflict as the persisted failure rather than a busy lease', async () => {
    const recovery = ports();
    recovery.inspect = vi.fn(async () => ({ status: 'failed', errorCode: 'CONVERSATION_CHANGED' }));
    vi.mocked(recovery.recover).mockRejectedValueOnce(new AppError('CONFLICT', 'Private obsolete checkpoint.'));
    const result = await tickAgentRecovery({ ports: recovery });
    expect(result.outcomes[0]).toEqual({ runId: first.id, status: 'failed', errorCode: 'CONVERSATION_CHANGED' });
    expect(JSON.stringify(result)).not.toContain('Private');
  });

  it('drains an active recovery but does not admit another candidate after shutdown', async () => {
    const shutdown = new AbortController();
    const recovery = ports();
    vi.mocked(recovery.recover).mockImplementationOnce(async run => {
      shutdown.abort();
      return { run: { id: run.id, status: 'waiting_verification' }, outcomes: [], message: 'Verification required.' } as unknown as RunRecoveryResponse;
    });
    const result = await tickAgentRecovery({ ports: recovery, signal: shutdown.signal });
    expect(result.outcomes).toEqual([{ runId: first.id, status: 'waiting_verification' }]);
    expect(recovery.recover).toHaveBeenCalledTimes(1);
  });

  it('stops the polling host when the completed tick signals shutdown', async () => {
    const shutdown = new AbortController();
    const recovery = ports();
    await runAgentRecoveryWorker({ ports: recovery, signal: shutdown.signal, onTick: () => { shutdown.abort(); } });
    expect(recovery.discover).toHaveBeenCalledTimes(1);
  });

  it('runs discovery without requiring a diagnostics callback', async () => {
    const shutdown = new AbortController();
    const recovery = ports();
    vi.mocked(recovery.discover).mockImplementationOnce(async () => { shutdown.abort(); return []; });
    await runAgentRecoveryWorker({ ports: recovery, signal: shutdown.signal });
    expect(recovery.discover).toHaveBeenCalledTimes(1);
  });

  it('performs no discovery after a shutdown has already been requested', async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const recovery = ports();
    expect(await tickAgentRecovery({ ports: recovery, signal: shutdown.signal })).toEqual({ discovered: 0, outcomes: [] });
    expect(recovery.discover).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5])('rejects an invalid batch limit %s before touching persistence', async limit => {
    const recovery = ports();
    await expect(tickAgentRecovery({ ports: recovery, limit })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(recovery.discover).not.toHaveBeenCalled();
  });

  it('parses bounded scheduling flags and refuses caller-supplied run or identity selectors', () => {
    expect(parseRecoveryArguments(['--once', '--limit', '2', '--interval-ms', '500']))
      .toEqual({ once: true, limit: 2, intervalMs: 500 });
    for (const args of [['--limit'], ['--interval-ms', 'NaN'], ['--limit', '101'], ['--user-id', 'foreign'], ['--now', '2099-01-01']]) {
      expect(() => parseRecoveryArguments(args)).toThrow();
    }
  });
});
