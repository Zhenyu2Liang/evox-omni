import type { ConversationIntent } from '@/lib/contracts/intent';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { BANKING_TOOL_OUTPUTS } from '@/lib/contracts/tool-output';
import { validatePlan } from '@/planner/dag';
import { AppError } from '@/lib/errors';
import { requestedExecutionTimes, scheduledTime } from '@/lib/scheduled-time';
import { requestedSteps } from '@/lib/request-steps';
import { isSupportedSpendingCategory, requestedConditions } from '@/lib/request-conditions';
import { demoNow } from '@/lib/clock';
import { businessCalendarParts, businessDate } from '@/lib/date';

/** Compile trusted business constraints before any workflow rows or side effects exist. */
export function compileRequestedPlan(
  proposed: TaskNodeSpec[],
  knownTools: Set<string>,
  request: string,
  intent?: ConversationIntent,
): TaskNodeSpec[] {
  if (intent?.status === 'draft') {
    throw new AppError('VALIDATION', 'The conversation intent requires clarification before execution.');
  }
  let nodes = bindRequestedCondition(proposed, request, intent);
  nodes = bindScheduledSteps(nodes, request);
  const validation = validatePlan(nodes, knownTools, BANKING_TOOL_OUTPUTS);
  if (!validation.ok) throw validation.error;
  return nodes;
}

function bindRequestedCondition(nodes: TaskNodeSpec[], request: string, intent?: ConversationIntent): TaskNodeSpec[] {
  const requested = intent?.conditions ?? requestedConditions(request);
  if (!requested.length) return nodes;
  const conditions = nodes.filter(node => node.kind === 'condition');
  if (requested.length !== 1 || conditions.length !== 1 || !conditions[0].condition) {
    throw new AppError('VALIDATION', 'The requested spending condition must map to one condition step.');
  }
  const conditionNode = conditions[0];
  const sourceId = conditionNode.condition!.path.split('.')[0];
  const source = nodes.find(node => node.id === sourceId);
  if (source?.tool !== 'analyze_spending') {
    throw new AppError('VALIDATION', 'The spending condition requires a spending analysis data source.');
  }
  const expected = requested[0];
  const category = expected.category;
  if (category && !isSupportedSpendingCategory(category)) {
    throw new AppError('VALIDATION', 'The spending condition requires a supported analysis category.');
  }
  const current = businessCalendarParts(demoNow());
  const period = businessCalendarParts(businessDate(current.year,
    current.month - (expected.period.relative === 'previous' ? 1 : 0)));
  const expectedMonth = expected.period.month ?? `${period.year}-${String(period.month + 1).padStart(2, '0')}`;
  return nodes.map(node => node.id === sourceId ? { ...node, args: { ...node.args, month: expectedMonth } }
    : node.id !== conditionNode.id ? node : {
    ...node,
    condition: {
      path: category ? `${sourceId}.categoryTotals.${category}` : `${sourceId}.total`,
      op: expected.operator,
      value: expected.threshold,
    },
  });
}

function bindScheduledSteps(nodes: TaskNodeSpec[], request: string): TaskNodeSpec[] {
  const steps = requestedSteps(request).filter(step => step.tool === 'create_scheduled_task');
  const scheduled = nodes.filter(node => node.kind === 'tool' && node.tool === 'create_scheduled_task');
  if (!scheduled.length) return nodes;
  const requested = steps.flatMap(step => {
    const times = requestedExecutionTimes(step.span);
    if (times.length > 1) throw new AppError('VALIDATION', 'A scheduled step contains multiple execution times.');
    return times;
  });
  if (requested.length > 0 && requested.length !== scheduled.length) {
    throw new AppError('VALIDATION', 'Every requested execution time requires a distinct scheduled step.');
  }
  const used = new Set<number>();
  const bound = new Map<string, Record<string, unknown>>();
  for (const node of scheduled) {
    const args = node.args ?? {};
    const runAt = scheduledTime(args, request);
    const matching = requested.map((time, index) => time.epoch === runAt ? index : -1).filter(index => index >= 0 && !used.has(index));
    if (requested.length > 0 && !matching.length) {
      throw new AppError('VALIDATION', 'Scheduled steps must bind one-to-one to their requested times.');
    }
    if (matching.length) used.add(matching[0]);
    bound.set(node.id, { ...args, runAt, runAtLocal: requested[matching[0]]?.local ?? args.runAtLocal });
  }
  return nodes.map(node => bound.has(node.id) ? { ...node, args: bound.get(node.id) } : node);
}
