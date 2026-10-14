import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { prisma } from '@/lib/db/client';
import { safeParse } from '@/lib/json';
import { runtimeRequestDigest } from './durable/serialization';
import type { SessionSnapshot } from './session';
import type { ResumeTurnInput } from './turns/contracts';

export interface AuthorizationToolContext {
  owner: AssistantMessage | null;
  call?: ToolCall;
  originatingUserText?: string;
  sourceModelRequestId?: string;
  originatingPurpose?: import('@/lib/contracts/intent').TurnPurpose;
}

function matchingCalls(messages: readonly AgentMessage[], id: string, name: string, args: unknown) {
  const digest = runtimeRequestDigest(name, args);
  return messages.flatMap(message => message.role === 'assistant' ? message.content.flatMap(block =>
    block.type === 'toolCall' && block.id === id && block.name === name && runtimeRequestDigest(name, block.arguments) === digest
      ? [{ owner: message, call: block }] : []) : []);
}

function savedAssistant(value: unknown): value is AssistantMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Partial<AssistantMessage>;
  return message.role === 'assistant' && Array.isArray(message.content) &&
    message.content.every(block => block !== null && typeof block === 'object' && typeof block.type === 'string') &&
    typeof message.timestamp === 'number' && typeof message.api === 'string' &&
    typeof message.provider === 'string' && typeof message.model === 'string';
}

/** Resolve provider ownership from the original action/invocation/request, not the latest call ID. */
export async function readAuthorizationToolContext(input: ResumeTurnInput, snapshot: SessionSnapshot,
  messages: readonly AgentMessage[]): Promise<AuthorizationToolContext | undefined> {
  if (!input.actionId) return undefined;
  const absent: AuthorizationToolContext = { owner: null };
  const action = await prisma.pendingAction.findFirst({ where: {
    id: input.actionId, userId: snapshot.userId, sessionId: snapshot.sessionId,
  } });
  if (!action) return absent;
  if (!action.invocationId) {
    // Non-journal gateway callers can bind a server-minted action ID, but never a repeated wire ID.
    const candidates = matchingCalls(messages, action.id, action.toolName, safeParse(action.argsJson, {}));
    return candidates.length === 1 ? candidates[0] : absent;
  }
  const child = await prisma.toolInvocation.findFirst({ where: { id: action.invocationId,
    run: { userId: snapshot.userId, sessionId: snapshot.sessionId } } });
  if (!child || child.toolName !== action.toolName) return absent;
  const target = child.origin === 'workflow' && child.parentInvocationId
    ? await prisma.toolInvocation.findFirst({ where: { id: child.parentInvocationId,
      run: { userId: snapshot.userId, sessionId: snapshot.sessionId } } }) : child;
  if (!target || target.origin !== 'pi' || (input.toolName && input.toolName !== target.toolName) ||
      (input.toolCallId && input.toolCallId !== target.callId)) return absent;
  const args = safeParse(target.argsJson, {});
  if (!target.modelRequestId) {
    const candidates = matchingCalls(messages, target.callId, target.toolName, args);
    return candidates.length === 1 ? candidates[0] : absent;
  }
  const request = await prisma.modelRequest.findFirst({ where: { id: target.modelRequestId, runId: target.runId }, select: { resultJson: true, inputJson: true } });
  const original = safeParse<unknown>(request?.resultJson, null);
  if (!savedAssistant(original)) return absent;
  const candidates = matchingCalls([original], target.callId, target.toolName, args);
  if (candidates.length !== 1) return absent;
  const inputContext = safeParse<{ messages?: AgentMessage[]; requestIntent?: import('@/lib/contracts/intent').ConversationIntent }>(request?.inputJson, {});
  const user = Array.isArray(inputContext.messages) ? inputContext.messages.findLast(message => message.role === 'user') : undefined;
  const originatingUserText = user?.role === 'user'
    ? typeof user.content === 'string' ? user.content : user.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : undefined;
  let originatingPurpose = inputContext.requestIntent?.purpose;
  if (originatingPurpose === 'undecided' && inputContext.requestIntent?.id) {
    const declarations = await prisma.toolInvocation.findMany({ where: { runId: target.runId, origin: 'pi', toolName: 'describe_turn', status: 'completed' }, select: { resultJson: true } });
    const declaration = declarations.map(row => safeParse<{ data?: { intentId?: string; purpose?: import('@/lib/contracts/intent').TurnPurpose } }>(row.resultJson, {}).data)
      .find(data => data?.intentId === inputContext.requestIntent!.id);
    originatingPurpose = declaration?.purpose;
  }
  return { ...candidates[0], sourceModelRequestId: target.modelRequestId, originatingPurpose,
    ...(originatingUserText ? { originatingUserText } : {}) };
}
