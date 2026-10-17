/**
 * Scenario 17 — 虚拟卡消费的入账时间由服务端决定：伪造时间必须被拒绝，且零资金副作用。
 *
 * A `consume_virtual_card` booking instant is SERVER-OWNED (`demoNow()`, UTC+08:00 month window,
 * see `banking-sdk/card.ts`): the published parameter set has only `cardId` / `amount` / `category` /
 * `merchant`. Forging the instant would move a spend OUT of the current monthly-limit window, so every
 * layer in the pipeline refuses a caller-supplied time — and none of them may silently drop it.
 *
 * WHERE the forged time is refused (verified against the code, mirrored by this spec's assertions):
 *
 *   1. FIRST REFUSING LAYER in this harness — Pi's `prepareArguments` hook that `createToolRegistry`
 *      installs on every banking tool (`agent/tools/index.ts:388-396`): it calls
 *      `validateBankingParameters(name, args, 'model')` (`agent/tools/plan-parameters.ts:44`), which for
 *      `consume_virtual_card` runs `rejectClientSuppliedTime(args, { callId })` (`agent/tools/card.ts:330`)
 *      BEFORE the generic unknown-parameter check (line 47 precedes line 48). The `AppError('VALIDATION')`
 *      message is `消费入账时间由服务端决定…`, never a generic "Unsupported parameters".
 *      Pi turns the thrown error into an ERROR tool result, so the call never reaches `beforeToolCall`
 *      → the Security Gateway never evaluates it → NO `PendingAction` is persisted (no panel).
 *      Pi's own TypeBox validation (`validateToolArguments`) is NOT what refuses: `ConsumeVirtualCardParams`
 *      simply has no time property, so it can neither accept nor reject the field by reason.
 *   2. `runConsumeVirtualCard` re-runs `rejectClientSuppliedTime(args)` inside its `try` BEFORE the SDK
 *      call (`agent/tools/card.ts:370`), so the model-free/registry path (`executeDirect`, plan nodes)
 *      is guarded too and returns `{ ok:false, errorCode:'VALIDATION', error:'消费入账时间由服务端决定…' }`.
 *   3. `banking-sdk/card.ts#consumeCard` re-checks the raw object for an `occurredAt` key before ANY read
 *      or write (defence in depth) — the last gate before a `channel='CARD'` ledger row or a
 *      `CardConsumption` row could be written.
 *   4. Plan layer: `agent/tools/planning.ts#preflightRequestedPlan` runs `validatePlanParameters` over EVERY
 *      compiled node (line 220) BEFORE any `AgentTask`/`AgentTaskNode` row is minted, so a forged plan node
 *      is refused with the same reason and nothing is persisted.
 *
 * Proven here (through the SCENARIO stack — faux model + security gateway + real registry + real SQLite):
 *   1. a model tool call carrying `occurredAt` is refused with the server-owned-time reason and moves nothing;
 *   2. the same holds for `bookedAt` / `timestamp` / `time` / `date`;
 *   3. replaying an already-persisted action whose `argsJson` carries the forged instant still fails
 *      `VALIDATION` with that reason and moves nothing (the gateway authorized the row; execution refused);
 *   4. a `submit_plan` node carrying the forged instant is refused before the plan is persisted, and a
 *      CONTROL plan with the same node minus the time field is accepted (the refusal is attributable to
 *      the time field, not to an unrelated plan error);
 *   5. structurally the registry publishes no time/date property and the LEGITIMATE MFA-confirmed
 *      consumption persists args without any time field, stamped from the server clock.
 *
 * NOT duplicated here: `agent/tools/consume-virtual-card.test.ts` (pure unit, mocked SDK) already covers
 * `validateBankingParameters` + the runner in isolation. This spec proves the same guarantee end to end.
 *
 * Fixtures: demo user 李明; `acct_checking` @ ¥23,580.00; no VIRTUAL card in the seed (one is created
 * through the gated `apply_virtual_card` MFA path per test). Helpers: ../helpers/*.
 */
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '@/agent/tools';
import { demoMonthRange } from '@/lib/clock';
import { MFA_CODE } from '@/lib/constants';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { createPendingAction } from '@/lib/db/repositories/pendingAction';
import { moneyToCents } from '@/lib/money';
import { security } from '@/security';
import { ACCOUNTS, DEMO_USER_ID } from '../helpers/fixtures';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import {
  cardsOfType,
  newSessionId,
  runTurn,
  toolEventsOf,
  verifyAction,
  type ScenarioResult,
} from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();

/** 活期结算账户（¥23,580.00）— the virtual card's single funding account. */
const CHECKING = ACCOUNTS[0];
/** Substring that identifies the SERVER-OWNED-TIME refusal (`agent/tools/card.ts#rejectClientSuppliedTime`). */
const TIME_REASON = '消费入账时间由服务端决定';
/** The generic refusal a plain unknown-parameter rejection would produce — must NOT be what we see. */
const GENERIC_REASON = 'Unsupported parameters';
/** A booking instant in a PREVIOUS month — forging it would move the spend out of this month's limit window. */
const FORGED_TIME = '2026-08-01T10:00:00+08:00';
const AMOUNT = '10.00';
const MONTHLY_LIMIT = '500.00';
const CONSUME_REQUEST = '用虚拟卡消费10元，入账时间按我给的日期记';

/** The exact client time-field names `rejectClientSuppliedTime` recognises (`agent/tools/card.ts:319`). */
const CLIENT_TIME_FIELDS = [
  'occurredAt',
  'occurredTime',
  'occurred_at',
  'bookedAt',
  'bookingTime',
  'timestamp',
  'time',
  'date',
  'occurredDate',
] as const;

/** The variants exercised case by case (field name → forged value). */
const FORGED_VARIANTS: Array<[string, unknown]> = [
  ['occurredAt', FORGED_TIME],
  ['bookedAt', '2026-08-01'],
  ['timestamp', 1_780_000_000_000],
  ['time', '10:00'],
  ['date', '2026-08-01'],
];

/** Every financial fact a forged booking instant could move. */
interface LedgerFacts {
  balanceMinor: bigint;
  /** Number of `channel='CARD'` rows — a virtual-card spend's own ledger signature. */
  cardTransactions: number;
  consumptions: number;
}

async function ledgerFacts(): Promise<LedgerFacts> {
  const prisma = getTestPrisma();
  const account = await prisma.account.findUniqueOrThrow({ where: { id: CHECKING.id } });
  return {
    balanceMinor: account.balanceMinor,
    cardTransactions: await prisma.transaction.count({ where: { channel: 'CARD' } }),
    consumptions: await prisma.cardConsumption.count(),
  };
}

/** Undecided `consume_virtual_card` actions — the only kind of panel that could still debit later. */
function undecidedConsumeActions(): Promise<number> {
  return getTestPrisma().pendingAction.count({
    where: { toolName: 'consume_virtual_card', status: { in: ['pending', 'awaiting_mfa'] } },
  });
}

/** The last tool-lifecycle entry of one tool in a turn (the terminal status of that call). */
function lastToolEvent(res: ScenarioResult, toolName: string) {
  const events = toolEventsOf(res, toolName);
  expect(events.length).toBeGreaterThan(0);
  return events[events.length - 1];
}

/** Seed a REAL VIRTUAL card through the gated RED `apply_virtual_card` path and return its id. */
async function seedVirtualCard(): Promise<string> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('apply_virtual_card', { monthlyLimit: MONTHLY_LIMIT })],
  });
  const res = await runTurn({ sessionId, message: `帮我申请一张月限额500元的虚拟卡`, agent });
  expect(res.mfa).toBeDefined();

  await verifyAction(agent, res.mfa!.actionId, MFA_CODE);

  const card = await getTestPrisma().card.findFirstOrThrow({
    where: { userId: DEMO_USER_ID, type: 'VIRTUAL' },
  });
  expect(card.status).toBe('ACTIVE');
  expect(card.monthlyLimitMinor).toBe(moneyToCents(MONTHLY_LIMIT));
  return card.id;
}

/** Drive one scripted turn whose single model step proposes `consume_virtual_card` with `args`. */
async function consumeTurn(args: Record<string, unknown>): Promise<ScenarioResult> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('consume_virtual_card', args), final('已发起虚拟卡消费。')],
  });
  return runTurn({ sessionId, message: CONSUME_REQUEST, agent });
}

/** The single `consume_virtual_card` plan node used by the plan-layer cases. */
function consumePlanNode(args: Record<string, unknown>) {
  return {
    id: 'n1',
    name: '虚拟卡消费',
    dependencies: [] as string[],
    kind: 'tool',
    tool: 'consume_virtual_card',
    args,
  };
}

/** Drive one scripted `submit_plan` turn over `nodes`. */
async function submitPlanTurn(nodes: ReturnType<typeof consumePlanNode>[]): Promise<ScenarioResult> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('submit_plan', { goal: CONSUME_REQUEST, nodes }), final('计划已提交。')],
  });
  return runTurn({ sessionId, message: CONSUME_REQUEST, agent });
}

describe('Scenario 17 — 虚拟卡消费入账时间由服务端决定（伪造时间守卫）', () => {
  /* ------------------------------------------------------- 1. the model tool-call layer */

  it('模型工具调用携带 occurredAt：以服务端时间理由被拒绝，扣款/流水/消费记录全为零', async () => {
    const cardId = await seedVirtualCard();
    const before = await ledgerFacts();
    expect(before.balanceMinor).toBe(moneyToCents(CHECKING.balance));
    expect(await undecidedConsumeActions()).toBe(0);

    const res = await consumeTurn({ cardId, amount: AMOUNT, occurredAt: FORGED_TIME });

    // The call neither succeeded nor parked a decision — no confirmation/MFA panel is surfaced.
    expect(toolEventsOf(res, 'consume_virtual_card').some((event) => event.status === 'success')).toBe(false);
    expect(res.mfa).toBeUndefined();
    expect(res.confirmation).toBeUndefined();

    // Refused BY REASON: the server-owned-time refusal, not the generic unknown-parameter rejection.
    const failure = lastToolEvent(res, 'consume_virtual_card');
    expect(failure.status).toBe('error');
    expect(failure.summary).toContain(TIME_REASON);
    expect(failure.summary).not.toContain(GENERIC_REASON);
    expect(cardsOfType(res, 'error').some((card) => card.message.includes(TIME_REASON))).toBe(true);

    // ZERO financial side effects.
    expect(await ledgerFacts()).toEqual(before);
    // The refusal happened BEFORE the security gateway gated anything: no action rows at all, so no
    // panel can later be confirmed into a debit.
    expect(await undecidedConsumeActions()).toBe(0);
    expect(await getTestPrisma().pendingAction.count({ where: { toolName: 'consume_virtual_card' } })).toBe(0);
    // The gateway never even EVALUATED the call (no `AuthorizationDecision` row): the refusal comes from
    // the `prepareArguments` hook installed by `createToolRegistry`, which runs before `beforeToolCall`.
    expect(
      await getTestPrisma().authorizationDecision.count({ where: { toolName: 'consume_virtual_card' } }),
    ).toBe(0);
  });

  /* ------------------------------------- 2. every recognised client time field, one by one */

  it.each(FORGED_VARIANTS)(
    '携带 %s 的消费同样以服务端时间理由被拒绝，且零副作用',
    async (field, value) => {
      const cardId = await seedVirtualCard();
      const before = await ledgerFacts();

      const res = await consumeTurn({ cardId, amount: AMOUNT, [field]: value });

      expect(toolEventsOf(res, 'consume_virtual_card').some((event) => event.status === 'success')).toBe(false);
      expect(res.mfa).toBeUndefined();
      expect(res.confirmation).toBeUndefined();

      const failure = lastToolEvent(res, 'consume_virtual_card');
      expect(failure.status).toBe('error');
      expect(failure.summary).toContain(TIME_REASON);
      expect(failure.summary).not.toContain(GENERIC_REASON);

      expect(await ledgerFacts()).toEqual(before);
      expect(await undecidedConsumeActions()).toBe(0);
    },
  );

  /* ------------------------------------------- 3. replay of an already-persisted action */

  it('已持久化的伪造时间动作在授权重放时仍以服务端时间理由失败，且零副作用', async () => {
    const cardId = await seedVirtualCard();
    const sessionId = newSessionId();
    const before = await ledgerFacts();
    const forgedArgs = { cardId, amount: AMOUNT, occurredAt: FORGED_TIME };
    const summary: PendingActionSummary = {
      title: '虚拟卡消费',
      toolName: 'consume_virtual_card',
      tier: 'RED',
      fields: [],
      requiresMfa: true,
    };

    // HONEST CONSTRUCTION: the gateway/validator normally refuses such a call BEFORE persisting, so the
    // forged row is written through the real repository to exercise the REPLAY seam explicitly. It is a
    // well-formed RED action that a human can still authorize — only execution must refuse.
    const row = await createPendingAction({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: 'consume_virtual_card',
      args: forgedArgs,
      tier: 'RED',
      requiresMfa: true,
      status: 'awaiting_mfa',
      summary,
      userRequest: CONSUME_REQUEST,
    });
    expect(JSON.parse(row.argsJson)).toEqual(forgedArgs);

    const gateway = security.gateway.securityGateway;

    // 1) No code yet: the gateway only issues a challenge and authorizes nothing.
    const prompted = await gateway.authorizeAction(row.id, { userId: DEMO_USER_ID, sessionId });
    expect(prompted.ok).toBe(false);
    expect(prompted.status).toBe('awaiting_mfa');

    // 2) The human supplies the code: authorization SUCCEEDS (the gateway never moves money itself)…
    const authorized = await gateway.authorizeAction(row.id, {
      userId: DEMO_USER_ID,
      sessionId,
      mfaCode: MFA_CODE,
    });
    expect(authorized.ok).toBe(true);
    expect(authorized.action).toBeDefined();
    expect(authorized.action!.args).toEqual(forgedArgs);

    // 3) …and the EXECUTION of those persisted args is refused with the server-owned-time reason.
    const replayed = await createToolRegistry(DEMO_USER_ID).executeDirect(
      authorized.action!.toolName,
      authorized.action!.args,
    );
    expect(replayed.ok).toBe(false);
    expect(replayed.errorCode).toBe('VALIDATION');
    expect(replayed.error).toContain(TIME_REASON);
    expect(replayed.error).not.toContain(GENERIC_REASON);

    // The forged instant bought nothing: no debit, no CARD ledger row, no consumption record.
    expect(await ledgerFacts()).toEqual(before);
    expect(await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'confirmed',
      resultJson: null,
    });
  });

  /* ------------------------------------------------------------- 4. the plan-node layer */

  it('submit_plan 携带伪造 occurredAt 的节点被服务端拒绝，且不持久化任何计划', async () => {
    const cardId = await seedVirtualCard();
    const before = await ledgerFacts();
    const taskCountBefore = await getTestPrisma().agentTask.count();

    const res = await submitPlanTurn([consumePlanNode({ cardId, amount: AMOUNT, occurredAt: FORGED_TIME })]);

    const failure = lastToolEvent(res, 'submit_plan');
    expect(failure.status).toBe('error');
    expect(failure.summary).toContain(TIME_REASON);
    expect(failure.summary).not.toContain(GENERIC_REASON);

    // Validation happens in `preflightRequestedPlan` BEFORE the AgentTask/node rows are minted.
    expect(res.plan).toBeUndefined();
    expect(cardsOfType(res, 'plan')).toHaveLength(0);
    expect(await getTestPrisma().agentTask.count()).toBe(taskCountBefore);

    // Nothing moved and nothing was parked for a later debit.
    expect(await ledgerFacts()).toEqual(before);
    expect(await undecidedConsumeActions()).toBe(0);
  });

  it('对照：同一计划去掉时间字段后被接受，节点停在高风险待验证（不动资金）', async () => {
    const cardId = await seedVirtualCard();
    const before = await ledgerFacts();

    const res = await submitPlanTurn([consumePlanNode({ cardId, amount: AMOUNT })]);

    // The SAME plan path accepts the node when no client time is smuggled in…
    expect(toolEventsOf(res, 'submit_plan').some((event) => event.status === 'success')).toBe(true);
    expect(toolEventsOf(res, 'consume_virtual_card').some((event) => event.status === 'error')).toBe(false);
    expect(res.plan).toBeDefined();

    // …and the node is parked for MFA (a real RED panel), so no money moved yet.
    const parked = await getTestPrisma().pendingAction.findMany({
      where: { toolName: 'consume_virtual_card', status: { in: ['pending', 'awaiting_mfa'] } },
    });
    expect(parked).toHaveLength(1);
    expect(parked[0].requiresMfa).toBe(true);
    expect(JSON.parse(parked[0].argsJson)).toEqual({ cardId, amount: AMOUNT });
    expect(await ledgerFacts()).toEqual(before);
  });

  /* -------------------------------------- 5. structural guard + the legitimate server time */

  it('注册表不发布任何时间/日期参数，合法 MFA 消费的持久化参数也不含时间字段', async () => {
    const registry = createToolRegistry(DEMO_USER_ID);
    const schema = registry.get('consume_virtual_card').parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const properties = Object.keys(schema.properties ?? {});
    expect(properties.sort()).toEqual(['amount', 'cardId', 'category', 'merchant']);
    expect([...(schema.required ?? [])].sort()).toEqual(['amount', 'cardId']);
    for (const field of CLIENT_TIME_FIELDS) expect(properties).not.toContain(field);

    // The LEGITIMATE path: the model proposes cardId/amount/category/merchant only.
    const cardId = await seedVirtualCard();
    const before = await ledgerFacts();
    const sessionId = newSessionId();
    const legitimateArgs = { cardId, amount: AMOUNT, category: '餐饮', merchant: '本地咖啡店' };
    const agent = buildFauxAgent({
      sessionId,
      script: [tool('consume_virtual_card', legitimateArgs), final('消费已提交，等待验证。')],
    });
    const res = await runTurn({ sessionId, message: '用虚拟卡消费10元买咖啡', agent });
    expect(res.mfa).toBeDefined();

    // The PERSISTED action carries exactly the published parameters — no booking time at all.
    const actionRow = await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: res.mfa!.actionId } });
    const persistedArgs = JSON.parse(actionRow.argsJson) as Record<string, unknown>;
    expect(Object.keys(persistedArgs).sort()).toEqual(['amount', 'cardId', 'category', 'merchant']);
    for (const field of CLIENT_TIME_FIELDS) expect(persistedArgs).not.toHaveProperty(field);

    await verifyAction(agent, res.mfa!.actionId, MFA_CODE);

    // The booking instant comes from the SERVER business clock (UTC+08:00 current month), never the model.
    const consumption = await getTestPrisma().cardConsumption.findFirstOrThrow({ where: { cardId } });
    const { start, end } = demoMonthRange();
    expect(consumption.occurredAt.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(consumption.occurredAt.getTime()).toBeLessThan(end.getTime());
    expect(consumption.amountMinor).toBe(moneyToCents(AMOUNT));

    // Exactly ONE spend: one extra CARD ledger row, one extra consumption, balance down by the amount.
    const after = await ledgerFacts();
    expect(after.cardTransactions).toBe(before.cardTransactions + 1);
    expect(after.consumptions).toBe(before.consumptions + 1);
    expect(after.balanceMinor).toBe(before.balanceMinor - moneyToCents(AMOUNT));
    expect(after.balanceMinor).toBe(moneyToCents(CHECKING.balance) - moneyToCents(AMOUNT));
  });
});
