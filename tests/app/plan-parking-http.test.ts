/**
 * tests/app/plan-parking-http.test.ts — REAL-application-entry (HTTP) end-to-end specs for DAG plan
 * PARKING during a chat turn + post-confirmation RESUME ("DAG 确认后继续").
 *
 * This is the app-entry counterpart of the `@/agent`-level conditional-DAG scenario
 * (`tests/scenarios/test-11-conditional-dag.test.ts`): it drives the REAL Next.js route handlers —
 * `POST /api/chat` (SSE) and `POST /api/actions/[id]/confirm` — with REAL `NextRequest` objects (see
 * `./harness.ts`). Underneath, the whole production stack runs (`route → @/agent runTurn →
 * createBankingAgent → banking tools → security gateway beforeToolCall → Banking SDK → SQLite`).
 * Only the MODEL is scripted: `tests/setup.ts` forces `LLM_MODE=mock`, so the deterministic mock
 * responder (`agent/providers/mock-responder.ts#handlePlan`) answers. Offline, no API key, no network.
 *
 * WHAT IS DISTINCT HERE (vs `tasks-http.test.ts`): that suite SEEDS a parked plan through the
 * production planner and drives the task/action lifecycle. THIS suite proves the park happens DURING
 * a real chat turn — the conditional limit-adjustment trigger yields a 3-node DAG
 * (`analyze_spending` → condition → YELLOW `set_card_limit`) whose gated node PARKS for confirmation
 * (the plan stream walks to `waiting_confirmation` with a `confirmation_required` + cards), and the
 * CHAT-PRODUCED `PendingAction` then RESUMES that plan to `success` when the human confirms — the
 * real `set_card_limit` runs and the seeded 娱乐 limit changes 3000 → 1500.
 *
 * DB lifecycle matches the other DB-backed suites: reset + seed before each test, disconnect after.
 * Every turn uses a FRESH session (the in-process circuit breaker is keyed by
 * `sessionId`); the route MINTS the persisted id itself (`getOrCreateSession`), so the id we assert
 * on is the one returned by the turn (the leading `session` SSE frame).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as chatPost } from '@/app/api/chat/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { GET as tasksGet } from '@/app/api/tasks/route';
import type { ActionResponse } from '@/app/api/_lib/types';
import type { AgentStreamEvent, ChatCard, ChatTurnResponse } from '@/lib/contracts/agent';
import type { TaskNodeStatus, TaskPlan } from '@/lib/contracts/task';
import { MFA_CODE } from '@/lib/constants';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { CARD_LIMITS } from '@/tests/helpers/fixtures';
import {
  actionUrl,
  chatUrl,
  getJson,
  idCtx,
  postJson,
  readSse,
  tasksUrl,
  type HttpResult,
} from './harness';

/* ------------------------------------------------------------------------------- fixtures */

/**
 * The conditional limit-adjustment trigger (verbatim). `mock-responder#handlePlan` turns it into:
 *   analyze (analyze_spending) → check (analyze.total > 2000) → setlimit (set_card_limit, YELLOW).
 * 本月 total is ~¥5,800 (> 2000), so the condition succeeds and the gated node is REACHED → parks.
 */
const MESSAGE = '如果这个月娱乐消费超过2000元，就把娱乐消费限额调整为1500元';

/** Seeded 娱乐 card limit on `card_credit` (fixtures.CARD_LIMITS) — unchanged while parked. */
const SEEDED_ENTERTAINMENT_LIMIT = CARD_LIMITS.find(
  (limit) => limit.cardId === 'card_credit' && limit.category === '娱乐',
)!.amount;
/** The new limit the parked node proposes (and the confirmed value). */
const NEW_ENTERTAINMENT_LIMIT = 1500;

/**
 * The route's JSON envelope — the transport shape (NOT a frozen `@/lib/contracts` type). Declared
 * structurally only so specs can narrow `ok`/`data`/`error` without importing app-private modules.
 */
interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/* -------------------------------------------------------------------------- envelope helpers */

/** Success protocol helper: assert the envelope and return its payload. */
function payload<T>(res: HttpResult<Envelope<T>>): T {
  expect(res.data?.ok, `expected success envelope, got ${JSON.stringify(res.data)}`).toBe(true);
  return res.data!.data as T;
}

/* -------------------------------------------------------------------------- event narrowing */

type PlanUpdateEvent = Extract<AgentStreamEvent, { type: 'plan_update' }>;
type ConfirmationEvent = Extract<AgentStreamEvent, { type: 'confirmation_required' }>;
type SessionEvent = Extract<AgentStreamEvent, { type: 'session' }>;
type CardEvent = Extract<AgentStreamEvent, { type: 'card' }>;

/** The ordered `plan_update` frames (each carries a full `TaskPlan` snapshot). */
function planUpdates(events: readonly AgentStreamEvent[]): PlanUpdateEvent[] {
  return events.filter((event): event is PlanUpdateEvent => event.type === 'plan_update');
}

/** The `confirmation_required` frame, if any. */
function confirmationOf(events: readonly AgentStreamEvent[]): ConfirmationEvent | undefined {
  return events.find((event): event is ConfirmationEvent => event.type === 'confirmation_required');
}

/** The `card` frames whose `card` payload has the given discriminant. */
function cardsOfType<T extends ChatCard['type']>(
  events: readonly AgentStreamEvent[],
  type: T,
): Array<Extract<ChatCard, { type: T }>> {
  return events
    .filter((event): event is CardEvent => event.type === 'card')
    .map((event) => event.card)
    .filter((card): card is Extract<ChatCard, { type: T }> => card.type === type);
}

/** The recorded node status in a plan snapshot (`undefined` when the node is absent). */
function nodeStatusOf(plan: TaskPlan, nodeId: string): TaskNodeStatus | undefined {
  return plan.results.find((result) => result.id === nodeId)?.status;
}

/* ----------------------------------------------------------------------------- parking turn */

/**
 * Drive ONE real SSE chat turn with the conditional limit-adjustment trigger, returning the freshly
 * MINted session id (from the leading `session` frame) and the ordered stream events.
 */
async function parkPlanTurn(): Promise<{ sessionId: string; events: AgentStreamEvent[] }> {
  const res = await postJson<Envelope<ChatTurnResponse>>(chatPost, chatUrl({}), {
    message: MESSAGE,
  });
  expect(res.status).toBe(200);
  expect(res.res.headers.get('content-type') ?? '').toContain('text/event-stream');

  const events = await readSse(res.res);
  const session = events.find((event): event is SessionEvent => event.type === 'session');
  expect(session, 'the SSE stream must open with a `session` frame').toBeDefined();
  return { sessionId: session!.sessionId, events };
}

/* -------------------------------------------------------------------------------- lifecycle */

beforeEach(async () => {
  await resetDatabase();
}, 30000);

afterAll(async () => {
  await disconnectTestPrisma();
});

/* ------------------------------------------------------------------------------------ specs */

describe('[integration] POST /api/chat — a conditional DAG plan PARKS on a gated node (real HTTP + mock)', () => {
  it('the streamed DAG walks analyze→check→setlimit and settles in waiting_confirmation', async () => {
    const { sessionId, events } = await parkPlanTurn();

    const updates = planUpdates(events);
    // The DAG progress is streamed live (one full snapshot per node change), so there are several.
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates.every((update) => update.plan.sessionId === sessionId)).toBe(true);

    // The FINAL streamed snapshot is the parked plan: the walk settled on the gated node.
    const finalPlan = updates[updates.length - 1].plan;
    expect(finalPlan.status).toBe('waiting_confirmation');
    expect(nodeStatusOf(finalPlan, 'analyze')).toBe('success');
    expect(nodeStatusOf(finalPlan, 'check')).toBe('success');
    expect(nodeStatusOf(finalPlan, 'setlimit')).toBe('waiting_confirmation');

    // The gated node was genuinely REACHED and entered `running` before parking (not skipped).
    const setlimitStatuses = updates.map((update) => nodeStatusOf(update.plan, 'setlimit'));
    expect(setlimitStatuses).toContain('running');
    expect(setlimitStatuses).toContain('waiting_confirmation');
    expect(setlimitStatuses).not.toContain('skipped');

    // No `error` frame is emitted on the reachable mock path.
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('emits a YELLOW confirmation_required and both a plan and a confirmation card', async () => {
    const { events } = await parkPlanTurn();

    const confirmation = confirmationOf(events);
    expect(confirmation, 'the parked node must surface a confirmation_required frame').toBeDefined();
    expect(confirmation!.action.tier).toBe('YELLOW');
    expect(confirmation!.action.toolName).toBe('set_card_limit');
    expect(confirmation!.action.requiresMfa).toBe(false);
    expect(confirmation!.actionId.length).toBeGreaterThan(0);

    // Cards: a plan card (the DAG snapshot) AND a confirmation card (the human decision).
    expect(cardsOfType(events, 'plan').length).toBeGreaterThanOrEqual(1);
    expect(cardsOfType(events, 'confirmation').length).toBeGreaterThanOrEqual(1);
    // A YELLOW gate never asks for MFA.
    expect(events.some((event) => event.type === 'mfa_required')).toBe(false);
  });
});

describe('[integration] the PARKING turn moved nothing and persisted the plan + a pending YELLOW action', () => {
  it('persists the plan (waiting_confirmation), a pending YELLOW action, and leaves the limit at 3000', async () => {
    const { sessionId, events } = await parkPlanTurn();
    const prisma = getTestPrisma();

    // The plan is DURABLE — it is listed through the real `GET /api/tasks` handler.
    const listed = await getJson<Envelope<{ plans: TaskPlan[] }>>(tasksGet, tasksUrl(), { sessionId });
    expect(listed.status).toBe(200);
    const plans = payload(listed).plans;
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.sessionId).toBe(sessionId);
    expect(plan.status).toBe('waiting_confirmation');
    expect(nodeStatusOf(plan, 'analyze')).toBe('success');
    expect(nodeStatusOf(plan, 'check')).toBe('success');
    expect(nodeStatusOf(plan, 'setlimit')).toBe('waiting_confirmation');

    // The persisted node rows agree with the streamed snapshot.
    const nodes = await prisma.agentTaskNode.findMany({
      where: { taskId: plan.id },
      orderBy: { order: 'asc' },
    });
    expect(nodes.map((node) => node.status)).toEqual(['success', 'success', 'waiting_confirmation']);

    // A YELLOW PendingAction was persisted for this session (the call was BLOCKED before any write).
    const parked = await prisma.pendingAction.findFirst({
      where: { sessionId, toolName: 'set_card_limit' },
    });
    expect(parked).not.toBeNull();
    expect(parked!.riskLevel).toBe('YELLOW');
    expect(parked!.requiresMfa).toBe(false);
    expect(parked!.status).toBe('pending');
    // The confirmation_required frame carries exactly that persisted action id.
    expect(confirmationOf(events)!.actionId).toBe(parked!.id);

    // NOT executed: the seeded 娱乐 limit is untouched.
    const limit = await prisma.cardLimit.findFirst({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    expect(limit?.amount).toBe(SEEDED_ENTERTAINMENT_LIMIT);
  });
});

describe('[integration] POST /api/actions/[id]/confirm — resumes the parked plan with the REAL result', () => {
  it('confirm (YELLOW) resumes the plan to success and applies the real limit change 3000 → 1500', async () => {
    const { sessionId, events } = await parkPlanTurn();
    const actionId = confirmationOf(events)!.actionId;

    const res = await postJson<Envelope<ActionResponse>>(
      confirmPost,
      actionUrl(actionId, 'confirm'),
      {},
      { ctx: idCtx(actionId), sessionId },
    );

    expect(res.status).toBe(200);
    const outcome = payload(res);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(outcome.tier).toBe('YELLOW');
    expect(outcome.requiresMfa).toBe(false);

    // The response LEADS with a refreshed `plan_update`: the parked plan resumed to `success` with
    // the gated `setlimit` node now `success`.
    const resumed = planUpdates(outcome.events)[0];
    expect(resumed, 'the confirm response must lead with a plan_update').toBeDefined();
    expect(resumed.plan.status).toBe('success');
    expect(nodeStatusOf(resumed.plan, 'setlimit')).toBe('success');
    expect(nodeStatusOf(resumed.plan, 'analyze')).toBe('success');
    expect(nodeStatusOf(resumed.plan, 'check')).toBe('success');

    // The literal MFA code never leaks (this gate has no MFA, but the invariant always holds).
    expect(JSON.stringify(res.data)).not.toContain(MFA_CODE);

    // The REAL `set_card_limit` ran: the seeded 娱乐 limit changed 3000 → 1500.
    const limit = await getTestPrisma().cardLimit.findFirst({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    expect(limit?.amount).toBe(NEW_ENTERTAINMENT_LIMIT);

    // The resumed plan is durable — the AgentTask settled `success`.
    const row = await getTestPrisma().agentTask.findUnique({ where: { id: resumed.plan.id } });
    expect(row!.status).toBe('success');
  });
});
