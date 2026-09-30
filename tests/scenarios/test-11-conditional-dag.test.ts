/**
 * Scenario Test 11 — "如果本月娱乐消费超过2000，就把娱乐限额调成1500" (conditional DAG plan).
 *
 * Pipeline: user message → Pi Agent (faux script) → submit_plan (planner DAG) → per-node
 * Security Gateway decision → analysis read (GREEN) + condition + gated set_card_limit (YELLOW).
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, confirmAction, newSessionId, toolEventsOf, cardsOfType } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';
// import { MONTHLY_SPEND_TOTAL } from '../helpers/fixtures';

describe('Scenario 11 — 条件DAG: 若本月娱乐>2000则调整娱乐限额到1500', () => {
  it.todo('submit_plan builds a DAG with an analysis node reading the 本月娱乐 total');
  it.todo('the plan contains a condition node evaluating analyze.total > 2000');
  it.todo('a dependent set_card_limit node declares a dependency on the condition node');
  it.todo('the plan card / plan_update events expose the node kinds and dependency order');
  it.todo('the set_card_limit node runs when the condition is true and is skipped when false');
  it.todo('when reached, the gated set_card_limit node waits for human confirmation (YELLOW)');
});
