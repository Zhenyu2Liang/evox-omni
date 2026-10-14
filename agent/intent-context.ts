import type { ConversationIntent, TurnPurpose } from '@/lib/contracts/intent';
import { newId } from '@/lib/ids';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { AppError } from '@/lib/errors';

export interface IntentContextOptions { id?: string }

/** Keep the latest user message verbatim; the model receives all prior context through Pi. */
export function advanceConversationIntent(_previous: ConversationIntent | undefined, message: string,
  options: IntentContextOptions = {}): ConversationIntent {
  return { id: options.id ?? newId('intent'), revision: 1, purpose: 'undecided',
    requestText: message, latestMessage: message, steps: [] };
}

/** The declaration is interpretation, not consent; actual operations still require server policy. */
export function declareConversationIntent(current: ConversationIntent, purpose: Exclude<TurnPurpose, 'undecided'>,
  operations: readonly string[], presentation: { allowProtocolExamples?: boolean; workflow?: boolean } = {}): ConversationIntent {
  if (operations.some(name => !catalogEntry(name) || catalogEntry(name)?.agentEnabled === false || name === 'submit_plan')) {
    throw new AppError('VALIDATION', 'Requested operations must be registered banking capabilities.');
  }
  if (purpose !== 'operation' && operations.some(name => catalogEntry(name)?.effect !== 'read')) {
    throw new AppError('VALIDATION', 'Discussion, advice and queries cannot declare banking writes.');
  }
  const tools = current.steps.map(step => step.tool);
  const preparingOperation = current.purpose === 'operation' &&
    current.steps.every(step => catalogEntry(step.tool)?.effect === 'read');
  if (presentation.allowProtocolExamples && purpose !== 'conversation') throw new AppError('VALIDATION', 'Protocol examples require an explanation turn.');
  if (presentation.workflow && purpose !== 'operation') throw new AppError('VALIDATION', 'A workflow requires an explicit operation purpose.');
  if (current.purpose !== 'undecided' && (current.purpose !== purpose ||
      !preparingOperation && (tools.length !== operations.length || tools.some((tool, index) => tool !== operations[index])) ||
      Boolean(current.allowProtocolExamples) !== Boolean(presentation.allowProtocolExamples) ||
      !preparingOperation && Boolean(current.workflow) !== Boolean(presentation.workflow))) {
    throw new AppError('CONFLICT', 'A turn declaration cannot change purpose or restart another operation.');
  }
  return { ...current, purpose, allowProtocolExamples: Boolean(presentation.allowProtocolExamples), workflow: Boolean(presentation.workflow),
    steps: operations.map((tool, index) => ({ key: `step-${index + 1}`, tool })) };
}

export function intentRequestText(intent: ConversationIntent | undefined, fallback = ''): string {
  return intent?.latestMessage ?? fallback;
}

export function requiresDeclaredPlan(intent: ConversationIntent | undefined): boolean {
  return Boolean(intent && (intent.workflow || intent.steps.filter(step => catalogEntry(step.tool)?.effect === 'write').length > 1));
}
