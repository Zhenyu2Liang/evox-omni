/**
 * run-turn-failure.test.ts — committed authorization outcomes bypass model narration.
 *
 * A gated action is executed and audited before the server renders its result. Both model modes
 * use the same financial renderer; model availability cannot hide a committed outcome or erase
 * dialogue received while the user was deciding.
 *
 * These specs pin that contract with the model runtime mocked out:
 *   1. a FAILING tool result is injected with `isError: true` and the real failure text (no success
 *      phrasing),
 *   2. a model configured to reject is never invoked after successful execution,
 *   3. delayed confirmation preserves both model dialogue and the visible transcript.
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
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { CONTACTS, DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

/** Options `createBankingAgent` receives (only the parts this double needs). */
interface FakeRuntimeOptions {
  sessionId: string;
  userId: string;
  config?: unknown;
  journal?: { bindRuntime(snapshot: () => unknown, config: unknown): void };
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
 * us prove that authorization result rendering never calls `agent.continue()`.
 */
const h = vi.hoisted(() => {
  const state = {
    /** What the next fake `agent.continue()` does. */
    continueBehavior: 'resolve' as 'resolve' | 'reject',
    continueCalls: 0,
    /** The most recently built fake runtime (assert against `state.last.agent.state.messages`). */
    last: null as unknown,
  };

  function makeRuntime(options: FakeRuntimeOptions) {
    const agent = {
      state: {
        systemPrompt: 'mock',
        model: { api: 'openai-completions', provider: 'mock', id: 'mock-model' },
        thinkingLevel: 'off',
        tools: [] as unknown[],
        messages: [...(options.snapshot?.agentState?.messages ?? [])],
        isStreaming: false,
        pendingToolCalls: new Set<string>(),
      },
      subscribe: () => () => {},
      prompt: async () => {},
      continue: async (): Promise<void> => {
        state.continueCalls++;
        if (state.continueBehavior === 'reject') throw new Error('Model narration failed.');
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
        ...options.snapshot,
        sessionId: options.sessionId,
        userId: options.userId,
        agentState: agent.state,
        transcript: options.snapshot?.transcript ?? [],
        createdAt: options.snapshot?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      }),
      dispose: () => {},
    };

    options.journal?.bindRuntime(() => runtime.serialize(), options.config);
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
function lastRuntime(): { agent: { state: { messages: AgentMessage[] } } } {
  return h.state.last as { agent: { state: { messages: AgentMessage[] } } };
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
  h.state.continueCalls = 0;
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
    snapshot.agentState.messages.push(
      fauxAssistantMessage([fauxToolCall('transfer_money', {}, { id: 'failed-transfer' })], { stopReason: 'toolUse' }),
      { role: 'toolResult', toolCallId: 'failed-transfer', toolName: 'transfer_money',
        content: [{ type: 'text', text: 'Waiting for confirmation.' }], isError: true, timestamp: 1 },
    );
    await saveSession(snapshot);

    const { events } = await resumeTurn({
      sessionId: snapshot.sessionId,
      toolName: 'transfer_money', toolCallId: 'failed-transfer',
      toolResult: { ok: false, error: FAILURE_TEXT },
    });

    // The injected tool-result message is the model's ONLY source for the outcome.
    const messages = lastRuntime().agent.state.messages;
    const injected = messages.find((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolCallId === 'failed-transfer')!;
    expect(injected.role).toBe('toolResult');
    expect(injected.isError).toBe(true);

    const text = (injected.content as Array<{ type: string; text?: string }>)
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join('');
    expect(JSON.parse(text).bankingError).toMatchObject({ code: 'TOOL_FAILED', message: FAILURE_TEXT, retryable: false });
    // Truthful: a failure must never carry success phrasing.
    expect(text).not.toContain('操作完成');
    expect(text).not.toContain('成功');
    expect(h.state.continueCalls).toBe(0);

    // The turn still settles cleanly (the failure is data, not an exception).
    expect(events[events.length - 1]).toEqual({ type: 'done' });
  });
});

describe('confirmation — server rendering preserves committed outcomes and conversation history', () => {
  it('returns the real result without contacting a model configured to reject narration', async () => {
    const snapshot = await getOrCreateSession(DEMO_USER_ID);
    const actionId = await parkTransfer(snapshot.sessionId, YELLOW_AMOUNT);

    h.state.continueBehavior = 'reject';
    const outcome = await confirmAction(actionId);

    // Model availability cannot affect an already committed banking outcome.
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(outcome.result?.ok).toBe(true);
    expect(outcome.result?.summary).toContain('转账');

    const errorEvent = outcome.events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'error' }> => event.type === 'error',
    );
    expect(errorEvent).toBeUndefined();
    expect(h.state.continueCalls).toBe(0);
    expect(outcome.message).toBe('操作已执行。');

    // The side effect really is committed: exactly one 'success' audit row for the session.
    const rows = await getTestPrisma().auditLog.findMany({
      where: { sessionId: snapshot.sessionId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
  });

  it('renders the committed result without a model narration request', async () => {
    const snapshot = await getOrCreateSession(DEMO_USER_ID);
    const actionId = await parkTransfer(snapshot.sessionId, YELLOW_AMOUNT);

    const outcome = await confirmAction(actionId);

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(outcome.result?.ok).toBe(true);
    expect(outcome.message).toBe('操作已执行。');
    expect(outcome.events.some((event) => event.type === 'error')).toBe(false);
    expect(h.state.continueCalls).toBe(0);
  });

  it('keeps every intervening user message and reply after delayed confirmation', async () => {
    const snapshot = await getOrCreateSession(DEMO_USER_ID);
    const actionId = await parkTransfer(snapshot.sessionId, YELLOW_AMOUNT);
    const parked = (await loadSession(snapshot.sessionId))!;
    const intervening: AgentMessage[] = [
      { role: 'user', content: 'Tell me a joke.', timestamp: 2 },
      fauxAssistantMessage('A short joke.'),
      { role: 'user', content: 'Remember my original negative amount.', timestamp: 3 },
      fauxAssistantMessage('Your earlier wording remains in the conversation.'),
    ];
    parked.agentState.messages.push(...intervening);
    parked.transcript.push(
      { id: 'intervening-question', role: 'user', content: 'Tell me a joke.', timestamp: 2 },
      { id: 'intervening-reply', role: 'assistant', content: 'A short joke.', timestamp: 3 },
    );
    await saveSession(parked);
    const outcome = await confirmAction(actionId);
    expect(outcome.status).toBe('executed');
    expect(h.state.continueCalls).toBe(0);
    const saved = (await loadSession(snapshot.sessionId))!;
    expect(saved.agentState.messages.slice(2, 2 + intervening.length)).toEqual(intervening);
    expect(saved.transcript.slice(0, 2)).toEqual(parked.transcript);
    expect(saved.agentState.messages.at(-1)?.role).toBe('assistant');
    expect(saved.transcript.at(-1)?.role).toBe('assistant');
  });
});
