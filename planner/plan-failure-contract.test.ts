/**
 * planner/plan-failure-contract.test.ts — regression coverage for the plan layer's STRUCTURED
 * refusal contract (`planner/failure.ts`, `planner/node-outcome.ts`, `planner/executor.ts`).
 *
 * What must hold and is asserted here:
 *  - a refusal reported by the injected `runTool` port reaches the node TYPED (`failure` /
 *    `actionStatus` carried verbatim through `settleToolNode`, `results`, `persistNode`,
 *    `onNodeUpdate` and the plan snapshot) so a renderer can use the typed facts
 *    (`lib/public-text#securityNotice`) instead of a generic fallback message;
 *  - no renderable node field (`error` / `summary` / `output`) ever carries an internal diagnostic
 *    (`__SECURITY_BLOCK__…` payloads, raw JSON, stack frames).
 *
 * Pure injection (`plan-test-harness.ts`): NO database, NO network.
 */
import { describe, expect, it } from 'vitest';

import { runPlan } from './executor';
import { settleToolNode } from './node-outcome';
import type { PlanFailure } from './failure';
import { createTranslator } from '@/lib/i18n/shared';
import { isInternalDiagnostic, securityNotice } from '@/lib/public-text';
import { AppError } from '@/lib/errors';
import { findResult, makePlan, NOW, planHarness, toolNode } from './plan-test-harness';

/** The raw gateway payload a security refusal is wrapped in — never renderable. */
const LOCKED_PAYLOAD = '__SECURITY_BLOCK__{"code":"MFA_LOCKED","reason":"mfa_attempts_exhausted"}';

/** An internal diagnostic carrying a stack frame — never renderable either. */
const STACK_PAYLOAD = '__SECURITY_BLOCK__{"code":"MFA_LOCKED"}\n    at foo (bar.ts:1:1)';

/** The typed facts of the exhausted-verification refusal. */
const LOCKED_FAILURE: PlanFailure = {
  code: 'MFA_LOCKED',
  reason: 'mfa_attempts_exhausted',
  attemptsUsed: 3,
  attemptsLeft: 0,
  maxAttempts: 3,
};

describe('planner · a typed refusal reaches the node, its text fields stay public-safe', () => {
  it('keeps every structured field of a locked refusal on the failed node and drops the payload', async () => {
    const h = planHarness(() => ({ ok: false, error: LOCKED_PAYLOAD, failure: LOCKED_FAILURE }));

    const out = await runPlan(makePlan([toolNode('pay')]), h.deps, { now: () => NOW });

    // EXACT shape: the typed failure survives unchanged, actionStatus is absent (never invented)
    // and `error` falls back to the business message instead of the gateway payload.
    expect(findResult(out, 'pay')).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'failed',
      startedAt: NOW,
      endedAt: NOW,
      error: 'Tool execution failed: tool_pay',
      failure: {
        code: 'MFA_LOCKED',
        reason: 'mfa_attempts_exhausted',
        attemptsUsed: 3,
        attemptsLeft: 0,
        maxAttempts: 3,
      },
    });
    expect(findResult(out, 'pay')?.error).not.toContain('__SECURITY_BLOCK__');
    expect(out.status).toBe('failed');
    expect(h.snapshots.at(-1)?.status).toBe('failed');
  });

  it('carries the parked action facts verbatim and lets a renderer use the typed reason', async () => {
    const retryable: PlanFailure = { code: 'MFA_FAILED', reason: 'mfa_code_invalid', attemptsLeft: 2 };
    const h = planHarness(() => ({
      ok: false,
      requiresConfirmation: true,
      pendingActionId: 'pa_1',
      actionStatus: 'awaiting_mfa',
      failure: retryable,
    }));

    const out = await runPlan(makePlan([toolNode('pay')]), h.deps, { now: () => NOW });

    expect(findResult(out, 'pay')).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'waiting_confirmation',
      startedAt: NOW,
      endedAt: NOW,
      output: { pendingActionId: 'pa_1' },
      pendingActionId: 'pa_1',
      actionStatus: 'awaiting_mfa',
      failure: { code: 'MFA_FAILED', reason: 'mfa_code_invalid', attemptsLeft: 2 },
    });
    expect(out.status).toBe('waiting_confirmation');

    // Downstream renders from the TYPED fields — not from the generic denial fallback.
    const t = createTranslator('en');
    const parked = findResult(out, 'pay');
    expect(securityNotice(parked?.failure, t)).toBe(t('chat.error.verificationRemaining', { count: 2 }));
    expect(securityNotice(parked?.failure, t)).not.toBe(t('chat.error.securityDenied'));
    expect(securityNotice({ ...parked?.failure, reason: 'mfa_attempts_exhausted' }, t))
      .toBe(t('chat.error.actionLocked'));
    expect(securityNotice(undefined, t)).toBe(t('chat.error.securityDenied'));
  });

  it('turns a THROWN refusal into a typed failure without publishing its diagnostic text', async () => {
    const h = planHarness(() => {
      throw new Error(STACK_PAYLOAD);
    });

    const out = await runPlan(makePlan([toolNode('pay')]), h.deps, { now: () => NOW });
    const node = findResult(out, 'pay');

    // `AppError.from` owns the code of an untyped throw (`INTERNAL`); the message is not public text.
    expect(node).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'failed',
      startedAt: NOW,
      endedAt: NOW,
      error: 'Tool execution failed: tool_pay',
      failure: { code: 'INTERNAL' },
    });
    expect(node?.error).not.toContain('__SECURITY_BLOCK__');
    expect(node?.error).not.toMatch(/\n\s+at\s/);
  });

  it('keeps the AppError code of a thrown typed refusal', async () => {
    const h = planHarness(() => {
      throw new AppError('MFA_LOCKED', LOCKED_PAYLOAD);
    });

    const out = await runPlan(makePlan([toolNode('pay')]), h.deps, { now: () => NOW });
    const node = findResult(out, 'pay');

    expect(node?.status).toBe('failed');
    expect(node?.failure).toEqual({ code: 'MFA_LOCKED' });
    expect(node?.error).toBe('Tool execution failed: tool_pay');
    expect(node?.error).not.toContain('__SECURITY_BLOCK__');
    expect(out.status).toBe('failed');
  });

  it('publishes no diagnostic text in the plan snapshot, the persisted rows or the update events', async () => {
    const h = planHarness((tool) =>
      tool === 'tool_pay'
        ? { ok: false, error: LOCKED_PAYLOAD, summary: STACK_PAYLOAD, failure: LOCKED_FAILURE }
        : {
            ok: false,
            requiresConfirmation: true,
            pendingActionId: 'pa_1',
            actionStatus: 'awaiting_mfa',
            error: LOCKED_PAYLOAD,
            summary: STACK_PAYLOAD,
            failure: { code: 'MFA_FAILED', reason: 'mfa_code_invalid', attemptsLeft: 2 },
          });

    const out = await runPlan(makePlan([toolNode('pay'), toolNode('gate')]), h.deps, { now: () => NOW });

    const serialized: Array<[string, string]> = [
      ['plan snapshot', JSON.stringify(out)],
      ['persisted node rows', JSON.stringify(h.nodeRows)],
      ['update events', JSON.stringify(h.updates)],
      ['persisted plan snapshots', JSON.stringify(h.snapshots)],
    ];
    for (const [label, text] of serialized) {
      expect(text, label).not.toContain('__SECURITY_BLOCK__');
      // A JSON-serialized stack frame keeps the newline ESCAPED (`\n    at `).
      expect(text, label).not.toContain('\\n    at ');
      expect(text, label).not.toContain('bar.ts:1:1');
    }

    // Every renderable text field of every recorded node is public-safe (the TYPED `failure` is not
    // renderable text: it legitimately serializes its own `code`).
    const renderable = [out.results, h.nodeRows, h.updates].flatMap((rows) =>
      rows.flatMap((row) => [(row as { error?: string }).error, (row as { summary?: string }).summary]),
    );
    // Exactly three renderable texts exist (pay's fallback in the snapshot, the node row and the
    // event) — a leaked diagnostic would show up here as a fourth entry.
    expect(renderable.filter((text): text is string => text !== undefined)).toEqual([
      'Tool execution failed: tool_pay',
      'Tool execution failed: tool_pay',
      'Tool execution failed: tool_pay',
    ]);
    for (const text of renderable) {
      if (text === undefined) continue;
      expect(isInternalDiagnostic(text)).toBe(false);
      expect(text).not.toContain('{"code"');
      expect(text).not.toMatch(/\n\s+at\s/);
    }
    expect(findResult(out, 'pay')?.error).toBe('Tool execution failed: tool_pay');
    expect(findResult(out, 'gate')?.error).toBeUndefined();
  });
});

describe('planner/node-outcome · settleToolNode projects renderable text, keeps structured facts', () => {
  it('drops a diagnostic error/summary on the failed branch and carries failure/actionStatus verbatim', () => {
    const settled = settleToolNode(
      toolNode('pay'),
      { ok: false, error: LOCKED_PAYLOAD, summary: STACK_PAYLOAD, failure: LOCKED_FAILURE, actionStatus: 'locked' },
      111,
      222,
    );

    expect(settled).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'failed',
      startedAt: 111,
      endedAt: 222,
      error: 'Tool execution failed: tool_pay',
      failure: {
        code: 'MFA_LOCKED',
        reason: 'mfa_attempts_exhausted',
        attemptsUsed: 3,
        attemptsLeft: 0,
        maxAttempts: 3,
      },
      actionStatus: 'locked',
    });
    expect(settled.summary).toBeUndefined();
  });

  it('keeps public business text on the success branch and drops a diagnostic summary', () => {
    const publicSummary = settleToolNode(
      toolNode('pay'),
      { ok: true, data: { balance: '100.00' }, summary: 'Balance retrieved.' },
      111,
      222,
    );
    expect(publicSummary).toEqual({
      id: 'pay',
      name: 'PAY',
      tool: 'tool_pay',
      status: 'success',
      startedAt: 111,
      endedAt: 222,
      output: { balance: '100.00' },
      summary: 'Balance retrieved.',
    });

    const hiddenSummary = settleToolNode(
      toolNode('pay'),
      { ok: true, data: { balance: '100.00' }, summary: STACK_PAYLOAD },
      111,
      222,
    );
    expect(hiddenSummary.summary).toBeUndefined();
    expect(hiddenSummary.output).toEqual({ balance: '100.00' });
  });
});
