/**
 * plan-limit-park — lives in the root Vitest test tree at `tests/unit/agent/providers/`, so the
 * root `vitest.config.ts` (its `test.include` covers every `*.{test,spec}.ts` under `tests/`)
 * auto-discovers it, and `npm run test` runs it with the rest of the suite.
 *
 * It pins the mock model's GATED conditional plan, i.e. the otherwise UNREACHABLE plan-parking
 * path over the offline mock LLM:
 *   "如果这个月娱乐消费超过2000元，就把娱乐消费限额调整为1500元"
 *     → `submit_plan` DAG: `analyze`(analyze_spending, GREEN) → `check`(condition analyze.total > 2000)
 *       → `setlimit`(set_card_limit, YELLOW ⇒ PARKS in `waiting_confirmation`).
 *
 * Part A is pure (`respond`); Part B drives the REAL production pipeline end-to-end offline
 * (`runTurn` → `createBankingAgent` → mock model → tools → gateway → SDK → test SQLite, then
 * `confirmAction`) and asserts the exact stream frames + persisted statuses + the REAL card-limit
 * mutation. `console.log` dumps the frames so a sibling test node can mirror the HTTP-level stream.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { AssistantMessage, Message, UserMessage } from '@earendil-works/pi-ai';

import { respond } from '@/agent/providers/mock-responder';
import type { MockContext } from '@/agent/providers/mock-responder';
import { confirmAction, runTurn } from '@/agent';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import { safeParse } from '@/lib/json';
import { readPendingActionId } from '@/agent/task-control';
import { getTask } from '@/lib/db/repositories/task';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

/** The canonical gated-plan trigger. */
const TRIGGER = '如果这个月娱乐消费超过2000元，就把娱乐消费限额调整为1500元';

/* ------------------------------------------------------------------------------- helpers */

function userMessage(content: string): UserMessage {
  return { role: 'user', content, timestamp: 0 } as UserMessage;
}

function ctx(messages: Message[]): MockContext {
  return { messages };
}

function firstToolCall(
  msg: AssistantMessage,
): { id: string; name: string; args: Record<string, any> } | undefined {
  for (const block of msg.content) {
    if (block.type === 'toolCall') return { id: block.id, name: block.name, args: block.arguments };
  }
  return undefined;
}

type PlanUpdateEvent = Extract<AgentStreamEvent, { type: 'plan_update' }>;

/** A compact, serialisable view of the emitted stream — the frames a sibling test should expect. */
function describeFrames(events: readonly AgentStreamEvent[]) {
  return events.map((event) => {
    if (event.type === 'plan_update') {
      return {
        type: event.type,
        planStatus: event.plan.status,
        nodes: event.plan.results.map((r) => `${r.id}:${r.status}`),
      };
    }
    if (event.type === 'confirmation_required') {
      return {
        type: event.type,
        actionId: event.actionId,
        tier: event.action.tier,
        toolName: event.action.toolName,
      };
    }
    if (event.type === 'tool_end' || event.type === 'tool_start') {
      return {
        type: event.type,
        toolName: event.toolEvent.toolName,
        status: event.toolEvent.status,
        tier: event.toolEvent.tier,
      };
    }
    if (event.type === 'card') return { type: event.type, cardType: event.card.type };
    if (event.type === 'text_delta') return { type: event.type, delta: event.delta };
    if (event.type === 'message_end') return { type: event.type, content: event.message.content };
    if (event.type === 'session') return { type: event.type, sessionId: event.sessionId };
    if (event.type === 'error') return { type: event.type, message: event.message };
    return { type: event.type };
  });
}

function planUpdates(events: readonly AgentStreamEvent[]): TaskPlan[] {
  return events
    .filter((event): event is PlanUpdateEvent => event.type === 'plan_update')
    .map((event) => event.plan);
}

/* ----------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ============================================================ Part A — pure responder */

describe('mock-responder — conditional LIMIT-ADJUSTMENT plan (gated node)', () => {
  it('emits a submit_plan DAG with analyze → check → setlimit(set_card_limit)', () => {
    const call = firstToolCall(respond(ctx([userMessage(TRIGGER)])));
    expect(call).toBeDefined();
    expect(call!.name).toBe('submit_plan');

    const { goal, nodes } = call!.args as { goal: string; nodes: any[] };
    expect(goal).toBe(TRIGGER);
    expect(nodes.map((n) => n.id)).toEqual(['analyze', 'check', 'setlimit']);

    expect(nodes[0]).toMatchObject({
      kind: 'tool',
      tool: 'analyze_spending',
      args: {},
      dependencies: [],
    });
    expect(nodes[1]).toMatchObject({
      kind: 'condition',
      dependencies: ['analyze'],
      condition: { path: 'analyze.total', op: '>', value: '2000' },
    });
    expect(nodes[2]).toMatchObject({
      kind: 'tool',
      tool: 'set_card_limit',
      dependencies: ['check'],
      args: { cardId: 'card_credit', category: '娱乐', amount: '1500' },
    });
  });

  it('preserves the pure-GREEN conditional plan when no limit adjustment is asked', () => {
    const call = firstToolCall(respond(ctx([userMessage('如果这个月消费超过2000元就提醒我')])));
    expect(call!.name).toBe('submit_plan');
    const { nodes } = call!.args as { nodes: any[] };
    expect(nodes.map((n) => n.kind)).toEqual(['tool', 'condition', 'note']);
    expect(nodes.some((n) => n.tool === 'set_card_limit')).toBe(false);
  });
});

/* ============================================================ Part B — full pipeline E2E */

describe('plan parking through the mock model (runTurn → confirmAction)', () => {
  it('parks the setlimit node, then confirm executes set_card_limit (card limit → ¥1500)', async () => {
    /* ---- 1. PARKING turn -------------------------------------------------------- */
    const { sessionId, events } = await runTurn({ message: TRIGGER });
    // eslint-disable-next-line no-console
    console.log('PARKING FRAMES:\n' + JSON.stringify(describeFrames(events), null, 0));

    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

    const plans = planUpdates(events);
    // analyze:running, analyze:success, check:success, setlimit:running, setlimit:waiting_confirmation
    expect(plans.map((p) => p.results.map((r) => `${r.id}:${r.status}`).join(','))).toEqual([
      'analyze:running,check:pending,setlimit:pending',
      'analyze:success,check:pending,setlimit:pending',
      'analyze:success,check:success,setlimit:pending',
      'analyze:success,check:success,setlimit:running',
      'analyze:success,check:success,setlimit:waiting_confirmation',
    ]);
    expect(plans.map((p) => p.status)).toEqual([
      'running',
      'running',
      'running',
      'running',
      'waiting_confirmation',
    ]);
    const parkedPlan = plans[plans.length - 1];
    expect(parkedPlan.results[1].output).toEqual({ result: true });

    // A YELLOW confirmation decision + card, then `done` LAST.
    const confirm = events.find((e) => e.type === 'confirmation_required');
    expect(confirm).toBeDefined();
    if (confirm?.type !== 'confirmation_required') throw new Error('unreachable');
    expect(confirm.action.tier).toBe('YELLOW');
    expect(confirm.action.toolName).toBe('set_card_limit');
    expect(events.filter((e) => e.type === 'card' && e.card.type === 'confirmation')).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe('done');

    /* ---- 2. PERSISTED state ----------------------------------------------------- */
    const prisma = getTestPrisma();
    const task = await prisma.agentTask.findFirstOrThrow({ where: { sessionId } });
    const nodeRows = await prisma.agentTaskNode.findMany({
      where: { taskId: task.id },
      orderBy: { order: 'asc' },
    });
    expect(nodeRows.map((n) => `${n.nodeId}:${n.status}`)).toEqual([
      'analyze:success',
      'check:success',
      'setlimit:waiting_confirmation',
    ]);
    expect(task.status).toBe('waiting_confirmation');

    const parkedRow = await getTask(task.id);
    const actionId = readPendingActionId(safeParse(parkedRow!.nodes[2].output, undefined));
    expect(typeof actionId).toBe('string');
    const pending = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId! } });
    expect(pending.toolName).toBe('set_card_limit');
    // PendingAction persists args as a JSON string in `argsJson` (there is no `args` column).
    expect(safeParse(pending.argsJson, {})).toMatchObject({
      cardId: 'card_credit',
      category: '娱乐',
      amount: '1500.00',
    });

    // The seeded 娱乐 limit is still 3000 — the gated node did NOT execute.
    const before = await prisma.cardLimit.findFirstOrThrow({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    expect(before.amountMinor).toBe(300000n);

    /* ---- 3. POST-CONFIRM continuation ------------------------------------------- */
    const outcome = await confirmAction(actionId!);
    // eslint-disable-next-line no-console
    console.log('CONFIRM FRAMES:\n' + JSON.stringify(describeFrames(outcome.events), null, 0));

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');

    // Leading plan_update advances the parked node to success and the plan to success.
    const lead = outcome.events[0];
    expect(lead.type).toBe('plan_update');
    if (lead.type !== 'plan_update') throw new Error('unreachable');
    expect(lead.plan.status).toBe('success');
    expect(lead.plan.results.map((r) => `${r.id}:${r.status}`)).toEqual([
      'analyze:success',
      'check:success',
      'setlimit:success',
    ]);
    // Then the narration turn: session first, done last.
    expect(outcome.events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(outcome.events[1]!.type).toBe('session');
    expect(outcome.events[outcome.events.length - 1]!.type).toBe('done');
    // The REAL tool summary is narrated (never fabricated).
    const text = outcome.events
      .filter((e): e is Extract<AgentStreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.delta)
      .join('');
    // The narration relays the REAL plan outcome: the outer `submit_plan` result (lead
    // 「任务计划：」) whose summary embeds the executed node's factual new limit — never fabricated.
    expect(text).toContain('¥1,500.00');

    // The REAL card limit moved: 3000 → 1500.
    const after = await getTestPrisma().cardLimit.findFirstOrThrow({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    expect(after.amountMinor).toBe(150000n);
  });
});

/* Keep an unused-import guard so the faux helpers stay referenced (kept for parity with the
 * sibling provider-mock spec's builders). */
void fauxAssistantMessage;
void fauxText;
void fauxToolCall;
