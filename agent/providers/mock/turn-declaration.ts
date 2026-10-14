import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import type { TurnPurpose } from '@/lib/contracts/intent';
import { classifyAdvisoryRequest } from './advisory-policy';
import { isConversationalRequest } from './conversation-policy';
import { requestedSteps } from './request-steps';
import { inferConversationGuidance } from './conversation-guidance';
import { catalogEntry } from '@/lib/contracts/tool-catalog';

export interface MockTurnDeclaration {
  purpose: Exclude<TurnPurpose, 'undecided'>;
  operations: string[];
  workflow?: boolean;
}

export function declareMockReadPreparation(readTool: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'operation', operations: [readTool] })], { stopReason: 'toolUse' });
}

/** Only the deterministic offline model interprets natural-language scripts. */
export function declareMockTurn(text: string, proposal: AssistantMessage): AssistantMessage {
  const calls = proposal.content.filter(part => part.type === 'toolCall');
  const workflow = calls.some(call => call.name === 'submit_plan');
  const planned = calls.flatMap(call => call.name === 'submit_plan' && Array.isArray(call.arguments.nodes)
    ? call.arguments.nodes.flatMap(node => node && typeof node === 'object' && !Array.isArray(node) && typeof node.tool === 'string' ? [node.tool] : [])
    : []);
  const requested = requestedSteps(text).map(step => step.tool);
  const operations = workflow ? planned : requested.length ? requested
    : calls.filter(call => call.name !== 'describe_turn').map(call => call.name);
  const write = operations.some(name => catalogEntry(name)?.effect === 'write');
  const advice = classifyAdvisoryRequest(text);
  const manualCard = inferConversationGuidance(text) === 'card_management_required';
  const purpose: Exclude<TurnPurpose, 'undecided'> = manualCard ? 'conversation' : workflow || advice === 'mixed' ? 'operation'
    : advice === 'advice' ? 'advice' : isConversationalRequest(text) ? 'conversation'
      : write ? 'operation' : 'query';
  const declared = purpose === 'conversation' ? [] : purpose === 'advice'
    ? operations.filter(name => catalogEntry(name)?.effect === 'read') : operations;
  const allowProtocolExamples = purpose === 'conversation' && /\b(?:JSON|protocol|schema|envelope)\b|\u534f\u8bae|\u4ee3\u7801\u793a\u4f8b/i.test(text);
  return fauxAssistantMessage([fauxToolCall('describe_turn', { purpose, operations: declared,
    ...(workflow ? { workflow: true } : {}), ...(allowProtocolExamples ? { allowProtocolExamples: true } : {}) },
    )], { stopReason: 'toolUse' });
}

export function lastMockTurnDeclaration(messages: readonly Message[], userIndex: number): MockTurnDeclaration | undefined {
  const result = messages.slice(userIndex + 1).findLast(message => message.role === 'toolResult' &&
    message.toolName === 'describe_turn' && !message.isError);
  if (result?.role !== 'toolResult') return;
  let value: unknown = result.details;
  if (value && typeof value === 'object' && 'data' in value) value = value.data;
  if (!value || typeof value !== 'object' || !('purpose' in value) || !('operations' in value)) {
    value = messages.slice(userIndex + 1).flatMap(message => message.role === 'assistant'
      ? message.content.filter(part => part.type === 'toolCall' && part.id === result.toolCallId).map(part =>
        part.type === 'toolCall' ? part.arguments : undefined) : []).at(-1);
  }
  if (!value || typeof value !== 'object' || !('purpose' in value) ||
      !['conversation', 'advice', 'query', 'operation'].includes(String(value.purpose)) ||
      !('operations' in value) || !Array.isArray(value.operations) || !value.operations.every(name => typeof name === 'string')) return;
  return { purpose: value.purpose as MockTurnDeclaration['purpose'], operations: value.operations,
    ...('workflow' in value && typeof value.workflow === 'boolean' ? { workflow: value.workflow } : {}) };
}

export function hasDeclarationTool(tools: readonly unknown[] | undefined, messages: readonly Message[] = []): boolean {
  const registered = tools ?? getCurrentTools(messages);
  return registered.some(tool => tool !== null && typeof tool === 'object' && 'name' in tool && tool.name === 'describe_turn');
}
