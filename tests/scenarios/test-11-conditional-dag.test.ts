/**
 * Scenario Test 11 — "如果本月娱乐消费超过2000，就把娱乐限额调成1500" (conditional DAG plan).
 *
 * Pipeline: user message → Pi Agent (faux script) → submit_plan (planner DAG) → per-node
 * Security Gateway decision → analysis read (GREEN) + condition + gated set_card_limit (YELLOW).
 *
 * `submit_plan` is a META tool (NOT risk-gated) so it executes inline; its DAG result surfaces as a
 * `plan` card (`res.plan`). Each plan NODE runs through the gateway: the `analyze_spending` read is
 * GREEN (runs), the `condition` node evaluates the prior node's output, and the `set_card_limit`
 * mutation is YELLOW — it is BLOCKED, parks as `waiting_confirmation`, and the plan walk breaks
 * (no money/limit change happens until a human confirms). The human decision then executes the
 * ORIGINAL validated args via the Banking SDK.
 *
 * Fixtures: demo user 李明; 本月 ordinary spend ¥5,800 (娱乐 ¥2,680); seeded 娱乐 card limit ¥3,000.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { TaskCondition, TaskNodeResult, TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';
import { dag } from '@/planner';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import {
  cardsOfType,
  confirmAction,
  newSessionId,
  runTurn,
  type ScenarioResult,
} from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { MONTHLY_SPEND_TOTAL } from '../helpers/fixtures';

describe('Scenario 11 — 条件DAG: 若本月娱乐>2000则调整娱乐限额到1500', () => {
  useFreshDatabase();

  /** Condition threshold of the scenario (本月娱乐 > ¥2,000). */
  const CONDITION_THRESHOLD = 2000;
  /** A threshold that can never be exceeded (¥5,800 > ¥99,999 is false) — flips the condition off. */
  const IMPOSSIBLE_THRESHOLD = 99999;
  /** Seeded per-category limit (fixtures.CARD_LIMITS: card_credit 娱乐 ¥3,000). */
  const SEEDED_ENTERTAINMENT_LIMIT = 3000;
  /** The new limit the plan node proposes (and the confirmed value). */
  const ENTERTAINMENT_LIMIT = 1500;
  /** 本月娱乐 spend in the fixtures (演唱会1880 + KTV480 + Steam200 + 影院120). */
  const MONTHLY_ENTERTAINMENT_SPEND = 2680;

  /** One model-proposed plan node (the loose shape `submit_plan` accepts). */
  interface ProposedNode {
    id: string;
    name: string;
    dependencies: string[];
    kind: 'tool' | 'condition' | 'note';
    tool?: string;
    args?: Record<string, unknown>;
    condition?: TaskCondition;
  }

  /**
   * The conditional DAG the model proposes. `conditionValue` is injectable so a test can flip the
   * condition TRUE (`2000`, since 本月 total is ¥5,800) or FALSE (`99999`).
   */
  function conditionalDag(conditionValue: number): { goal: string; nodes: ProposedNode[] } {
    return {
      goal: '若本月娱乐消费超过2000则调整娱乐限额',
      nodes: [
        {
          id: 'analyze',
          name: '分析本月消费',
          dependencies: [],
          kind: 'tool',
          tool: 'analyze_spending',
          args: {},
        },
        {
          id: 'cond',
          name: '判断娱乐消费>2000',
          dependencies: ['analyze'],
          kind: 'condition',
          condition: { path: 'analyze.total', op: '>', value: conditionValue },
        },
        {
          id: 'setlimit',
          name: '调整娱乐限额',
          dependencies: ['cond'],
          kind: 'tool',
          tool: 'set_card_limit',
          args: { cardId: 'card_credit', category: '娱乐', amount: ENTERTAINMENT_LIMIT },
        },
      ],
    };
  }

  /** Drive one `submit_plan` turn in a FRESH session (uniqueness isolates the in-process breaker). */
  async function submitConditionalPlan(conditionValue: number): Promise<{
    sessionId: string;
    agent: ReturnType<typeof buildFauxAgent>;
    res: ScenarioResult;
  }> {
    const sessionId = newSessionId();
    const agent = buildFauxAgent({
      sessionId,
      script: [
        tool('submit_plan', conditionalDag(conditionValue)),
        final('已生成条件计划，敏感操作节点需要你确认。'),
      ],
    });
    const res = await runTurn({
      sessionId,
      message: '如果本月娱乐消费超过2000，就把娱乐限额调成1500',
      agent,
    });
    return { sessionId, agent, res };
  }

  /** The submitted plan snapshot the turn surfaced (a `plan` card carries it). */
  function requirePlan(res: ScenarioResult): TaskPlan {
    expect(res.plan).toBeDefined();
    return res.plan as TaskPlan;
  }

  /** The proposed node spec (`res.plan.nodes`) by id. */
  function nodeSpec(plan: TaskPlan, id: string): TaskNodeSpec {
    const node = plan.nodes.find((entry) => entry.id === id);
    expect(node, `plan node '${id}'`).toBeDefined();
    return node as TaskNodeSpec;
  }

  /** The executed node result (`res.plan.results`) by id. */
  function nodeResult(plan: TaskPlan, id: string): TaskNodeResult {
    const result = plan.results.find((entry) => entry.id === id);
    expect(result, `plan result '${id}'`).toBeDefined();
    return result as TaskNodeResult;
  }

  it('submit_plan builds a DAG with an analysis node reading the 本月娱乐 total', async () => {
    const { res } = await submitConditionalPlan(CONDITION_THRESHOLD);
    const plan = requirePlan(res);

    // The analysis node is a declared `tool` node bound to the GREEN `analyze_spending` capability.
    const analyze = nodeSpec(plan, 'analyze');
    expect(analyze.kind).toBe('tool');
    expect(analyze.tool).toBe('analyze_spending');

    // …and it actually RAN inline (GREEN), reading the current-(demo-)month spend.
    const result = nodeResult(plan, 'analyze');
    expect(result.status).toBe('success');
    const output = result.output as {
      month: string;
      total: number;
      byCategory: Array<{ category: string; amount: number }>;
    };
    expect(output.month).toBe('2026-09');
    expect(output.total).toBe(MONTHLY_SPEND_TOTAL);
    // 娱乐 is what the condition targets — the seed makes it ¥2,680 (the largest category).
    const entertainment = output.byCategory.find((entry) => entry.category === '娱乐');
    expect(entertainment?.amount).toBe(MONTHLY_ENTERTAINMENT_SPEND);
  });

  it('the plan contains a condition node evaluating analyze.total > 2000', async () => {
    const { res } = await submitConditionalPlan(CONDITION_THRESHOLD);
    const plan = requirePlan(res);

    const cond = nodeSpec(plan, 'cond');
    expect(cond.kind).toBe('condition');
    expect(cond.condition).toEqual({ path: 'analyze.total', op: '>', value: 2000 });

    // Evaluated against the REAL analysis output: ¥5,800 > 2,000 ⇒ true.
    const result = nodeResult(plan, 'cond');
    expect(result.status).toBe('success');
    expect(result.output).toEqual({ result: true });
  });

  it('a dependent set_card_limit node declares a dependency on the condition node', async () => {
    const { res } = await submitConditionalPlan(CONDITION_THRESHOLD);
    const plan = requirePlan(res);

    const setlimit = nodeSpec(plan, 'setlimit');
    expect(setlimit.kind).toBe('tool');
    expect(setlimit.tool).toBe('set_card_limit');
    expect(setlimit.dependencies).toEqual(['cond']);
    expect(setlimit.args).toEqual({ cardId: 'card_credit', category: '娱乐', amount: 1500 });
  });

  it('the plan card / plan_update events expose the node kinds and dependency order', async () => {
    const { res } = await submitConditionalPlan(CONDITION_THRESHOLD);
    const plan = requirePlan(res);

    // A `plan` card carrying the DAG snapshot was surfaced to the UI.
    const planCards = cardsOfType(res, 'plan');
    expect(planCards).toHaveLength(1);
    expect(planCards[0].plan).toEqual(plan);

    // Node kinds are exposed per node.
    expect(nodeSpec(plan, 'analyze').kind).toBe('tool');
    expect(nodeSpec(plan, 'cond').kind).toBe('condition');
    expect(nodeSpec(plan, 'setlimit').kind).toBe('tool');

    // Dependency edges: analyze → cond → setlimit.
    expect(nodeSpec(plan, 'analyze').dependencies).toEqual([]);
    expect(nodeSpec(plan, 'cond').dependencies).toEqual(['analyze']);
    expect(nodeSpec(plan, 'setlimit').dependencies).toEqual(['cond']);

    // The planner orders the DAG topologically exactly as declared.
    expect(dag.topologicalOrder(plan.nodes).map((node) => node.id)).toEqual([
      'analyze',
      'cond',
      'setlimit',
    ]);
  });

  it('the set_card_limit node runs when the condition is true and is skipped when false', async () => {
    // TRUE — 本月 total (¥5,800) > 2,000 ⇒ the condition succeeds, so the gated node is REACHED.
    const truthy = await submitConditionalPlan(CONDITION_THRESHOLD);
    const truthyPlan = requirePlan(truthy.res);
    expect(nodeResult(truthyPlan, 'cond').status).toBe('success');
    expect(nodeResult(truthyPlan, 'setlimit').status).toBe('waiting_confirmation');

    // FALSE — 本月 total (¥5,800) > 99,999 is false ⇒ the condition skips, so its dependent is skipped.
    const falsy = await submitConditionalPlan(IMPOSSIBLE_THRESHOLD);
    const falsyPlan = requirePlan(falsy.res);
    expect(nodeResult(falsyPlan, 'cond').status).toBe('skipped');
    expect(nodeResult(falsyPlan, 'setlimit').status).toBe('skipped');

    // The skipped gated node queued NO pending action — nothing was even proposed to the human.
    const parked = await getTestPrisma().pendingAction.findMany({
      where: { sessionId: falsy.sessionId, toolName: 'set_card_limit' },
    });
    expect(parked).toHaveLength(0);
  });

  it('when reached, the gated set_card_limit node waits for human confirmation (YELLOW)', async () => {
    const { sessionId, agent, res } = await submitConditionalPlan(CONDITION_THRESHOLD);
    const plan = requirePlan(res);

    // The walk parks at the gated node: the plan status is `waiting_confirmation`.
    expect(plan.status).toBe('waiting_confirmation');
    const setlimit = nodeResult(plan, 'setlimit');
    expect(['waiting_confirmation', 'waiting_verification']).toContain(setlimit.status);

    // A YELLOW PendingAction was persisted (the call was BLOCKED before any DB write).
    const prisma = getTestPrisma();
    const parked = await prisma.pendingAction.findFirst({
      where: { sessionId, toolName: 'set_card_limit' },
    });
    expect(parked).not.toBeNull();
    const actionId = parked?.id as string;
    expect(parked?.riskLevel).toBe('YELLOW');
    expect(parked?.requiresMfa).toBe(false);

    // The node output exposes the pending-action id — the handle the human decision addresses.
    const output = setlimit.output as { pendingActionId?: string } | undefined;
    expect(output?.pendingActionId).toBe(actionId);

    // NOT executed yet: the seeded 娱乐 limit is still ¥3,000.
    const before = await prisma.cardLimit.findFirst({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    expect(before?.amount).toBe(SEEDED_ENTERTAINMENT_LIMIT);

    // Human confirmation executes the ORIGINAL validated args → 娱乐 limit becomes ¥1,500.
    await confirmAction(agent, actionId);
    const after = await prisma.cardLimit.findFirst({
      where: { cardId: 'card_credit', category: '娱乐' },
    });
    expect(after?.amount).toBe(ENTERTAINMENT_LIMIT);
  });
});
