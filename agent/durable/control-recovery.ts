import { validateToolArguments, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import type { AgentRun, ToolInvocation } from '@/lib/db/prisma';
import type { ConversationIntent } from '@/lib/contracts/intent';
import type { AppConfig } from '@/lib/config';
import { prisma } from '@/lib/db/client';
import { saveRunCheckpoint } from '@/lib/db/repositories/agentRun';
import { AppError } from '@/lib/errors';
import { safeParse, toJson } from '@/lib/json';
import { createTurnIntentTool, TURN_INTENT_TOOL } from '@/agent/tools/turn-intent';
import { decodeCheckpoint, encodeCheckpoint } from './checkpoint';
import { runtimeRequestDigest } from './serialization';
import type { AgentRunJournal } from './journal';

/** Replay interpretation only, using its original model call and the same saved user turn. */
export async function recoverTurnIntentControl(invocation: ToolInvocation, run: AgentRun,
  journal: AgentRunJournal, config: AppConfig): Promise<string> {
  if (invocation.origin !== 'pi' || invocation.runId !== run.id || invocation.toolName !== TURN_INTENT_TOOL ||
      !invocation.modelRequestId || !run.checkpointJson) {
    throw new AppError('CONFLICT', 'The interpretation recovery has no original model checkpoint.');
  }
  await journal.assertLeaseOwned(prisma);
  const model = await prisma.modelRequest.findFirst({ where: { id: invocation.modelRequestId, runId: run.id,
    run: { userId: run.userId, sessionId: run.sessionId }, status: 'completed' },
    select: { inputJson: true, resultJson: true } });
  const source = safeParse<AssistantMessage | null>(model?.resultJson, null);
  const calls = source?.role === 'assistant' && Array.isArray(source.content)
    ? source.content.filter((part): part is ToolCall => part.type === 'toolCall' && part.id === invocation.callId && part.name === TURN_INTENT_TOOL) : [];
  if (calls.length !== 1) throw new AppError('CONFLICT', 'The interpretation has no unique original completed model call.');
  const checkpoint = decodeCheckpoint(run.checkpointJson, config);
  const snapshot = checkpoint.snapshot;
  const original = safeParse<{ requestIntent?: ConversationIntent }>(model?.inputJson, {}).requestIntent;
  const current = snapshot.intent;
  if (snapshot.userId !== run.userId || snapshot.sessionId !== run.sessionId || snapshot.revision !== run.baseRevision ||
      !original || !current || original.id !== current.id || original.revision !== current.revision ||
      original.latestMessage !== current.latestMessage || original.requestText !== current.requestText) {
    throw new AppError('CONFLICT', 'The interpretation checkpoint belongs to a different user turn.');
  }
  const tool = createTurnIntentTool(() => snapshot.intent!, async intent => {
    snapshot.intent = intent;
    const checkpointJson = encodeCheckpoint(snapshot, config);
    await saveRunCheckpoint(journal.lease, 'turn_intent', checkpointJson);
    run.checkpointJson = checkpointJson;
    run.checkpointStage = 'turn_intent';
  });
  const args = validateToolArguments(tool, calls[0]);
  if (invocation.requestDigest !== runtimeRequestDigest(TURN_INTENT_TOOL, args) ||
      runtimeRequestDigest(TURN_INTENT_TOOL, safeParse(invocation.argsJson, null)) !== runtimeRequestDigest(TURN_INTENT_TOOL, args)) {
    throw new AppError('CONFLICT', 'The interpretation arguments do not match their original invocation.');
  }
  // A checkpoint may already contain the original control result from before readiness became a
  // model argument. Replay its saved interpretation instead of silently changing it on upgrade.
  const replayArgs = args.needsInput === undefined && current.purpose !== 'undecided' && current.needsInput !== undefined
    ? { ...args, needsInput: current.needsInput } : args;
  const result = await tool.execute(invocation.callId, replayArgs);
  return toJson({ ok: true, data: result.details,
    content: result.content, usage: result.usage,
    summary: result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') });
}
