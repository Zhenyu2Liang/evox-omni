/**
 * Scenario Test 12 — "爱人11月20日生日，帮我准备1000元预算" (cross-scenario multi-node plan).
 *
 * Pipeline: user message → Pi Agent (faux script) → submit_plan → reserve_budget (GREEN) +
 * create_scheduled_task (YELLOW confirm) → Security Gateway (beforeToolCall) → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it().
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it, expect } from 'vitest';
import { buildFauxAgent, tool, final } from '../helpers/faux-agent';
import { runTurn, confirmAction, newSessionId, cardsOfType } from '../helpers/scenario';
import { useFreshDatabase, getTestPrisma } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { demoNow } from '@/lib/clock';
import type { TaskPlan } from '@/lib/contracts/task';

/** The demo clock pins "today" to 2026-09-25; the birthday reminder is for 11-18 (near 11-20). */
const demoYear = new Date(demoNow()).getFullYear();
const BIRTHDAY_REMINDER_AT = new Date(demoYear, 10, 18, 9, 0).getTime(); // 2026-11-18 09:00 local

/** The budget name created by the GREEN `reserve_budget` node (distinct from the seeded 生日礼物). */
const BUDGET_NAME = '生日预算';
/** The reminder name created by the YELLOW `create_scheduled_task` node. */
const REMINDER_NAME = '爱人生日提醒';

/** The two-node DAG the model proposes: reserve the budget, then schedule a reminder depending on it. */
function birthdayPlanArgs(): { goal: string; nodes: Record<string, unknown>[] } {
  return {
    goal: '为爱人11月20日生日准备1000元预算',
    nodes: [
      {
        id: 'budget',
        name: '预留生日预算1000元',
        dependencies: [],
        kind: 'tool',
        tool: 'reserve_budget',
        args: { name: BUDGET_NAME, amount: '1000', purpose: '生日' },
      },
      {
        id: 'remind',
        name: '设置生日提醒',
        dependencies: ['budget'],
        kind: 'tool',
        tool: 'create_scheduled_task',
        args: {
          name: REMINDER_NAME,
          kind: 'REMINDER',
          runAt: BIRTHDAY_REMINDER_AT,
          payload: { note: '爱人11月20日生日，已预留1000元预算' },
        },
      },
    ],
  };
}

/** Drive one birthday-plan turn with a fresh session id (breaker isolation) + scripted model. */
async function runBirthdayTurn(): Promise<{
  sessionId: string;
  agent: ReturnType<typeof buildFauxAgent>;
  res: Awaited<ReturnType<typeof runTurn>>;
}> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('submit_plan', birthdayPlanArgs()), final('已生成生日预算计划。')],
  });
  const res = await runTurn({ sessionId, message: '爱人11月20日生日，帮我准备1000元预算', agent });
  return { sessionId, agent, res };
}

/** The pending-action id the planner surfaced for the parked `remind` node. */
function pendingActionIdOf(plan: TaskPlan): string | undefined {
  const remind = plan.results.find((node) => node.id === 'remind');
  const output = remind?.output as { pendingActionId?: string } | undefined;
  return output?.pendingActionId;
}

describe('Scenario 12 — 生日预算计划 (reserve_budget + create_scheduled_task)', () => {
  useFreshDatabase();

  it('submit_plan builds a plan with a reserve_budget node (¥1000, purpose 生日) and a create_scheduled_task node (reminder near 11-20)', async () => {
    const { sessionId, res } = await runBirthdayTurn();

    expect(res.error).toBeUndefined();
    expect(res.plan).toBeDefined();
    const plan = res.plan as TaskPlan;
    expect(plan.sessionId).toBe(sessionId);
    expect(plan.goal).toContain('生日');

    const budgetNode = plan.nodes.find((node) => node.id === 'budget');
    expect(budgetNode).toBeDefined();
    expect(budgetNode?.kind).toBe('tool');
    expect(budgetNode?.tool).toBe('reserve_budget');
    expect(budgetNode?.args).toMatchObject({ name: BUDGET_NAME, amount: '1000', purpose: '生日' });

    const remindNode = plan.nodes.find((node) => node.id === 'remind');
    expect(remindNode).toBeDefined();
    expect(remindNode?.kind).toBe('tool');
    expect(remindNode?.tool).toBe('create_scheduled_task');
    expect(remindNode?.args).toMatchObject({ name: REMINDER_NAME, kind: 'REMINDER' });

    // The reminder is scheduled near the birthday (11-20), anchored to the demo clock's year.
    const runAt = (remindNode?.args as { runAt?: number } | undefined)?.runAt;
    expect(runAt).toBe(BIRTHDAY_REMINDER_AT);
    const scheduled = new Date(runAt as number);
    expect(scheduled.getFullYear()).toBe(demoYear);
    expect(scheduled.getMonth()).toBe(10); // November
    expect(scheduled.getDate()).toBeGreaterThanOrEqual(18);
    expect(scheduled.getDate()).toBeLessThanOrEqual(20);
  });

  it('the plan card exposes both nodes and their order/dependencies', async () => {
    const { res } = await runBirthdayTurn();

    // The `plan` card is the UI surface for the submitted DAG, streamed as a `card` event.
    const planCards = cardsOfType(res, 'plan');
    expect(planCards).toHaveLength(1);
    const plan = planCards[0].plan;

    const planCardEvents = res.events.filter(
      (event) => event.type === 'card' && event.card.type === 'plan',
    );
    expect(planCardEvents).toHaveLength(1);
    expect(res.plan).toEqual(plan);

    // Exactly the two tool nodes, in declaration (== topological) order.
    expect(plan.nodes.map((node) => node.id)).toEqual(['budget', 'remind']);
    expect(plan.nodes.map((node) => node.kind)).toEqual(['tool', 'tool']);

    // The dependency edge: remind dependsOn budget; budget is a root.
    const budgetNode = plan.nodes.find((node) => node.id === 'budget');
    const remindNode = plan.nodes.find((node) => node.id === 'remind');
    expect(budgetNode?.dependencies).toEqual([]);
    expect(remindNode?.dependencies).toEqual(['budget']);

    // Results follow the same order: budget (GREEN) settles before the parked remind.
    expect(plan.results.map((node) => node.id)).toEqual(['budget', 'remind']);
    expect(plan.results.find((node) => node.id === 'budget')?.status).toBe('success');
    expect(plan.results.find((node) => node.id === 'remind')?.status).toBe('waiting_confirmation');
  });

  it('reserve_budget runs GREEN (auto-executes) and creates the Budget row', async () => {
    const { sessionId, res } = await runBirthdayTurn();
    const plan = res.plan as TaskPlan;

    const budgetResult = plan.results.find((node) => node.id === 'budget');
    expect(budgetResult?.status).toBe('success');
    // The GREEN node returned the created BudgetView (no confirmation).
    expect(budgetResult?.output).toMatchObject({
      name: BUDGET_NAME,
      amount: '1000.00',
      purpose: '生日',
      status: 'RESERVED',
    });

    const prisma = getTestPrisma();
    const budgetRow = await prisma.budget.findFirst({
      where: { userId: DEMO_USER_ID, name: BUDGET_NAME },
    });
    expect(budgetRow).not.toBeNull();
    expect(budgetRow?.amountMinor).toBe(100_000n);
    expect(budgetRow?.purpose).toBe('生日');
    expect(budgetRow?.status).toBe('RESERVED');

    // GREEN ⇒ nothing was parked for reserve_budget.
    const pending = await prisma.pendingAction.findFirst({
      where: { sessionId, toolName: 'reserve_budget' },
    });
    expect(pending).toBeNull();
  });

  it('create_scheduled_task is classified YELLOW and waits for confirmation', async () => {
    const { sessionId, res } = await runBirthdayTurn();
    const plan = res.plan as TaskPlan;

    const remindResult = plan.results.find((node) => node.id === 'remind');
    expect(remindResult?.status).toBe('waiting_confirmation');
    expect(plan.status).toBe('waiting_confirmation');

    const prisma = getTestPrisma();
    const pending = await prisma.pendingAction.findFirst({
      where: { sessionId, toolName: 'create_scheduled_task' },
    });
    expect(pending).not.toBeNull();
    expect(pending?.riskLevel).toBe('YELLOW');
    expect(pending?.requiresMfa).toBe(false);
    expect(pending?.status).toBe('pending');

    // The planner surfaced the persisted pending-action id on the parked node.
    expect(pendingActionIdOf(plan)).toBe(pending?.id);

    // Blocked BEFORE any execution: no ScheduledTask row exists yet.
    const notYet = await prisma.scheduledTask.findFirst({
      where: { userId: DEMO_USER_ID, name: REMINDER_NAME },
    });
    expect(notYet).toBeNull();
  });

  it('after confirm the ScheduledTask row is written with a date near 11-20', async () => {
    const { sessionId, agent, res } = await runBirthdayTurn();
    const plan = res.plan as TaskPlan;

    const prisma = getTestPrisma();
    const pending = await prisma.pendingAction.findFirst({
      where: { sessionId, toolName: 'create_scheduled_task' },
    });
    const actionId = pendingActionIdOf(plan) ?? pending?.id;
    expect(actionId).toBeDefined();

    await confirmAction(agent, actionId as string);

    const task = await prisma.scheduledTask.findFirst({
      where: { userId: DEMO_USER_ID, name: REMINDER_NAME },
    });
    expect(task).not.toBeNull();
    expect(task?.kind).toBe('REMINDER');
    expect(task?.status).toBe('SCHEDULED');
    expect(task?.runAt.getFullYear()).toBe(demoYear);
    expect(task?.runAt.getMonth()).toBe(10); // November
    const day = task?.runAt.getDate() as number;
    expect(day).toBeGreaterThanOrEqual(18);
    expect(day).toBeLessThanOrEqual(20);

    // The human decision settled the pending action.
    const settled = await prisma.pendingAction.findFirst({
      where: { sessionId, toolName: 'create_scheduled_task' },
    });
    expect(settled?.status).toBe('confirmed');
  });
});
