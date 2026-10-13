/**
 * run-turn-failure.test.ts — hardening of the confirmation CONTINUATION failure path.
 *
 * A gated (YELLOW/RED) action is executed and AUDITED *before* `agent.continue()` narrates it
 * (`agent/confirmation.ts` → `agent/run-turn.ts`). The continuation may therefore fail while the
 * business outcome is already committed. Such a failure must NEVER be swallowed and must NEVER be
 * turned into a success: the caller still receives the REAL `ToolExecutionResult`.
 *
 * These specs pin that contract with the model runtime mocked out:
 *   1. a FAILING tool result is injected with `isError: true` and the real failure text (no success
 *      phrasing),
 *   2. a `continue()` rejection AFTER a successful gated execution still returns the real result
 *      (`ok:true`, status `executed`) and surfaces a `{type:'error'}` stream event,
 *   3. the happy path still narrates normally (no spurious error event) — regression guard.
 *
 * Everything EXCEPT the model runtime is production code: the security gateway, the tool registry,
 * the Banking SDK and the SQLite test DB are the real ones; `LLM_MODE=mock` keeps the run offline.
 *
 * Imports use the `@/…` alias so the file works both at ./agent/ and after relocation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmAction, getOrCreateSession, loadSession, resumeTurn, saveSession } from '@/agent';
import { security } from '@/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

/** Options `createBankingAgent` receives (only the parts this double needs). */
interface FakeRuntimeOptions {
  sessionId: string;
  userId: string;
  snapshot?: {
    agentState?: { messages?: unknown[] };
    transcript?: unknown[];
    createdAt?: number;
  };
}

/**
 * Mutable, hoisted test double for `@/agent/banking-agent`.
 *
 * `resumeTurn` builds its runtime through `createBankingAgent`; replacing that ONE factory keeps the
 * whole turn/confirmation pipeline (contracts, event mapping, session persistence) real while letting
 * us make `agent.continue()` — the model's narration step — resolve or reject on demand.
 */
const h = vi.hoisted(() => {
  const state = {
    /** What the next fake `agent.continue()` does. */
    continueBehavior: 'resolve' as 'resolve' | 'reject',
    /** The most recently built fake runtime (assert against `state.last.agent.state.messages`). */
    last: null as unknown,
  };

  function makeRuntime(options: FakeRuntimeOptions) {
    const agent = {
      state: {
        systemPrompt: 'mock',
        model: undefined,
        thinkingLevel: 'off',
        tools: [] as unknown[],
        messages: [...(options.snapshot?.agentState?.messages ?? [])],
        isStreaming: false,
        pendingToolCalls: new Set<string>(),
      },
      subscribe: () => () => {},
      prompt: async () => {},
      continue: async (): Promise<void> => {
        if (state.continueBehavior === 'reject') throw new Error('模型续播失败');
      },
    };

    const runtime = {
      agent,
      sessionId: options.sessionId,
      userId: options.userId,
      registry: {
        tools: {},
        list: () => [],
        get: () => {
          throw new Error('registry.get is not used by resumeTurn');
        },
        executeDirect: async () => ({ ok: true }),
      },
      serialize: () => ({
        sessionId: options.sessionId,
        userId: options.userId,
        agentState: agent.state,
        transcript: options.snapshot?.transcript ?? [],
        createdAt: options.snapshot?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }),
      dispose: () => {},
    };

    state.last = runtime;
    return runtime;
  }

  return { state, makeRuntime };
});

vi.mock('@/agent/banking-agent', () => ({
  createBankingAgent: (options: never) => h.makeRuntime(options),
}));

/** The gateway's runtime surface — its only runtime member (see agent/CONTEXT.md). */
const gateway = security.gateway.securityGateway;

/** The demo request ("给张伟转200元，备注AA"), its recipient and a YELLOW amount (≤ ¥1000). */
const USER_MESSAGE = '给张伟转200元，备注AA';
const RECIPIENT = CONTACTS[0];
const YELLOW_AMOUNT = '200.00';
/** The real failure the SDK/tool reported (must never be rephrased as a success). */
const FAILURE_TEXT = '付款账户余额不足，转账未完成';

/** The fake runtime built by the LAST `createBankingAgent` call. */
function lastRuntime(): { agent: { state: { messages: ToolResultMessage[] } } } {
  return h.state.last as { agent: { state: { messages: ToolResultMessage[] } } };
}

/** Propose a `transfer_money` call through the REAL gateway; assert it was gated + persisted. */
async function parkTransfer(sessionId: string, amount: string): Promise<string> {
  const auth = await gateway.handleToolCall({
    sessionId,
    userId: DEMO_USER_ID,
    toolName: 'transfer_money',
    args: { name: RECIPIENT.name, amount },
    userRequest: USER_MESSAGE,
  });

  expect(auth.evaluation.blocked).toBe(true);
  expect(auth.action).toBeDefined();
  // Model double: persist the same original tool call that a real Agent parks.
  // Continuation must not succeed by inventing a result for an empty transcript.
  const snapshot = await loadSession(sessionId);
  if (snapshot === null) throw new Error('missing test session');
  snapshot.agentState.messages.push(
    fauxAssistantMessage([fauxToolCall('transfer_money', { name: RECIPIENT.name, amount }, { id: auth.action!.id })], { stopReason: 'toolUse' }),
    { role: 'toolResult', toolCallId: auth.action!.id, toolName: 'transfer_money',
      content: [{ type: 'text', text: '等待确认' }], isError: true, timestamp: Date.now() },
  );
  await saveSession(snapshot);
  return auth.action!.id;
}

/* ----------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  h.state.continueBehavior = 'resolve';
  h.state.last = null;
  await resetDatabase();
}, 30000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestPrisma();
});

/* --------------------------------------------------------------------------------- tests */

describe('resumeTurn — a failing tool result is never phrased as a success', () => {
  it('injects the failure with isError:true and the REAL error text', async () => {
    const snapshot = await getOrCreateSession(DEMO_USER_ID);

    const { events } = await resumeTurn({
      sessionId: snapshot.sessionId,
      toolResult: { ok: false, error: FAILURE_TEXT },
    });

    // The injected tool-result message is the model's ONLY source for the outcome.
    const messages = lastRuntime().agent.state.messages;
    const injected = messages[messages.length - 1];
    expect(injected.role).toBe('toolResult');
    expect(injected.isError).toBe(true);

    const text = (injected.content as Array<{ type: string; text?: string }>)
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('');
    expect(text).toBe(FAILURE_TEXT);
    // Truthful: a failure must never carry success phrasing.
    expect(text).not.toContain('操作完成');
    expect(text).not.toContain('成功');

    // The turn still settles cleanly (the failure is data, not an exception).
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});

describe('confirmation — a continuation failure never hides the executed action', () => {
  it('returns the REAL result + an error event when continue() rejects after execution', async () => {
    const snapshot = await getOrCreateSession(DEMO_USER_ID);
    const actionId = await parkTransfer(snapshot.sessionId, YELLOW_AMOUNT);

    h.state.continueBehavior = 'reject';
    const outcome = await confirmAction(actionId);

    // The business action ALREADY ran and is ALREADY audited — the rejection affects narration only.
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(outcome.result?.ok).toBe(true);
    expect(outcome.result?.summary).toContain('转账');

    // The failure is surfaced as a stream event (never swallowed) ...
    const errorEvent = outcome.events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'error' }> => event.type === 'error',
    );
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).toContain('模型续播失败');

    // ... and it is clearly flagged, never reported as a plain success.
    expect(outcome.message).toContain('操作已执行。');
    expect(outcome.message).toContain('结果播报失败');
    expect(outcome.message).not.toBe('操作已执行。');

    // The side effect really is committed: exactly one 'success' audit row for the session.
    const rows = await getTestPrisma().auditLog.findMany({
      where: { sessionId: snapshot.sessionId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
  });

  it('narrates normally (no error event) when the continuation succeeds', async () => {
    const snapshot = await getOrCreateSession(DEMO_USER_ID);
    const actionId = await parkTransfer(snapshot.sessionId, YELLOW_AMOUNT);

    const outcome = await confirmAction(actionId);

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(outcome.result?.ok).toBe(true);
    expect(outcome.message).toBe('操作已执行。');
    expect(outcome.events.some((event) => event.type === 'error')).toBe(false);
  });
});
