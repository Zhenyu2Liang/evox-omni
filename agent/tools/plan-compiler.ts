import type { ConversationIntent } from '@/lib/contracts/intent';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { BANKING_TOOL_OUTPUTS } from '@/lib/contracts/tool-output';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { validatePlan, topologicalOrder } from '@/planner/dag';
import { AppError } from '@/lib/errors';
import { scheduledTime } from '@/lib/scheduled-time';

/** Validate declared structure without extracting parameters or dependencies from prose. */
export function compileRequestedPlan(
  proposed: TaskNodeSpec[],
  knownTools: Set<string>,
  _request: string,
  intent?: ConversationIntent,
): TaskNodeSpec[] {
  const validation = validatePlan(proposed, knownTools, BANKING_TOOL_OUTPUTS);
  if (!validation.ok) throw validation.error;
  const isWrite = (tool: string | undefined) => tool !== undefined && catalogEntry(tool)?.effect === 'write';
  const actual = topologicalOrder(proposed).filter(node => node.kind === 'tool' && isWrite(node.tool)).map(node => node.tool);
  if (intent) {
    if (intent.purpose === 'undecided') {
      throw new AppError('VALIDATION', 'Declare the current turn purpose before submitting a plan.');
    }
    if (actual.length > 0 && intent.purpose !== 'operation') {
      throw new AppError('SECURITY_DENIED', 'This turn does not permit banking write proposals.');
    }
    const expected = intent.steps.filter(step => isWrite(step.tool)).map(step => step.tool);
    if (actual.length !== expected.length || actual.some((tool, index) => tool !== expected[index])) {
      throw new AppError('VALIDATION', 'The plan must cover the declared banking writes exactly once and in the declared order.');
    }
  }
  return proposed.map(node => node.kind === 'tool' && node.tool === 'create_scheduled_task'
    ? { ...node, args: { ...node.args, runAt: scheduledTime(node.args ?? {}) } } : node);
}
