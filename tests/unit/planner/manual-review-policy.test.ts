import { describe, expect, it } from 'vitest';
import { reviewControlState, type ReviewTaskState } from '@/agent/manual-review-policy';
import type { AgentTaskNode, PendingAction } from '@prisma/client';

const task = (status: string, executionToken: string | null = null): ReviewTaskState => ({ status, executionToken, nodes: [] });

describe('operator checkpoint policy', () => {
  it('keeps a live executor in requested handoff until its execution claim is released', () => {
    expect(reviewControlState('open', task('paused', 'live-executor'), [])).toMatchObject({
      handoffStatus: 'human_review_requested', mayStop: false, mayResume: false,
    });
  });

  it('also waits for a confirmed command even after the plan walk released its token', () => {
    expect(reviewControlState('open', task('paused'), [{ status: 'confirmed' } as PendingAction])).toMatchObject({
      handoffStatus: 'human_review_requested', mayStop: false, mayResume: false,
    });
  });

  it('allows a safe checkpoint to resume while preserving parked authorization', () => {
    const paused = { ...task('paused'), nodes: [{ status: 'waiting_confirmation' } as AgentTaskNode] };
    expect(reviewControlState('open', paused, [{ status: 'pending' } as PendingAction])).toMatchObject({
      handoffStatus: 'operator_controlled', mayStop: true, mayResume: true,
    });
  });

  it('allows unknown results to be stopped but never resumes them automatically', () => {
    expect(reviewControlState('open', task('paused'), [{ status: 'needs_reconciliation' } as PendingAction])).toMatchObject({
      handoffStatus: 'operator_controlled', mayStop: true, mayResume: false,
    });
  });
});
