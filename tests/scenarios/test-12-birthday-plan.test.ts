/**
 * Scenario Test 12 — "爱人11月20日生日，帮我准备1000元预算" (cross-scenario multi-node plan).
 *
 * Pipeline: user message → Pi Agent (faux script) → submit_plan → reserve_budget (GREEN) +
 * create_scheduled_task (YELLOW confirm) → Security Gateway (beforeToolCall) → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, confirmAction, newSessionId, toolEventsOf, cardsOfType } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';

describe('Scenario 12 — 生日预算计划 (reserve_budget + create_scheduled_task)', () => {
  it.todo('submit_plan builds a plan with a reserve_budget node (¥1000, purpose 生日) and a create_scheduled_task node (reminder near 11-20)');
  it.todo('the plan card / plan_update events expose both nodes and their order/dependencies');
  it.todo('reserve_budget runs GREEN (auto-executes) and creates the Budget row');
  it.todo('create_scheduled_task is classified YELLOW and waits for confirmation');
  it.todo('after confirm the ScheduledTask row is written with a date near 11-20');
});
