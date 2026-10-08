/**
 * banking-agent.ts — builds and owns the Pi `Agent` instance for one session.
 * ONLY place a Pi Agent is constructed. Loads the banking system prompt, builds the per-user tool
 * registry (`./tools`), selects the provider (`./providers`), restores `AgentState`, and installs:
 *  - `beforeToolCall` → `security.gateway.securityGateway.handleToolCall` (the ONE security
 *    chokepoint; returns `{block:true, reason}` for any gated tool — the model CANNOT execute
 *    YELLOW/RED itself);
 *  - `afterToolCall`  → records the tool outcome for the UI stream.
 * The agent NEVER decides a tier; money moves only via the two-phase confirmation flow (`./confirmation`).
 *
 * A restored `SessionSnapshot.agentState` is replayed through `initialState` (systemPrompt, model,
 * tools and `messages`), so a continuation turn after a human confirmation keeps the SAME
 * conversation; `serialize()` hands the current state back to `./session` for persistence.
 */
import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentMessage,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';
import { getConfig, type AppConfig } from '@/lib/config';
import type { ToolName } from '@/lib/contracts/tools';
import type { TaskPlan } from '@/lib/contracts/task';
import { security } from '@/security';
import { createToolRegistry, type ToolRegistry } from './tools';
import { executeGatedTool } from './confirmation';
import { buildAutomaticWriteFence } from './execution-fence';
import { resolveProvider } from './providers';
import { buildSystemPrompt } from './system-prompt';
import { normalizeToolResultMessages } from './message-normalize';
import type { SessionSnapshot } from './session';

/**
 * The security gateway's runtime surface.
 *
 * Reconciliation with the security node: `security.gateway` re-exports the `security-gateway`
 * MODULE, whose individual functions (`handleToolCall`, `authorizeAction`, `cancelAction`, …) are
 * module-private — the node's public runtime API is the exported `securityGateway` object (exactly
 * what `security/security-gateway.ts` documents and what `tests/unit/security/gateway.test.ts`
 * targets). Routing through the facade therefore means `security.gateway.securityGateway.*`.
 */
const gateway = security.gateway.securityGateway;
/**
 * Latest user utterance in the transcript, as plain text.
 *
 * AUDIT ONLY: it is passed to the gateway as `userRequest` (what the user asked) and NEVER has any
 * influence on the permission tier / confirmation / MFA decision — those come from the code policy
 * table alone (see `@/security`). Returns `''` when the transcript has no user message yet.
 */
function latestUserText(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const { content } = message;
    if (typeof content === 'string') return content;
    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }
  return '';
}

export interface BankingAgentOptions {
  sessionId: string;
  userId: string;
  /** Restored AgentState + transcript; omitted ⇒ fresh session. */
  snapshot?: SessionSnapshot;
  /** Override config (tests). Defaults to `getConfig()`. */
  config?: AppConfig;
  /**
   * Optional LIVE DAG-progress sink: invoked with the full plan snapshot after every node change of
   * a `submit_plan` run, so `./run-turn` can stream `plan_update` and the parked-node decision
   * events. When omitted, a `submit_plan` turn still surfaces its plan card but streams no
   * per-node progress (backward compatible — the model/agent pipeline is unchanged).
   */
  onPlanUpdate?: (plan: TaskPlan) => void | Promise<void>;
}
export interface BankingAgentRuntime {
  agent: Agent;
  sessionId: string;
  userId: string;
  registry: ToolRegistry;
  /** Current pi AgentState + UI transcript, ready to persist. */
  serialize(): SessionSnapshot;
  /** Remove all stream listeners. */
  dispose(): void;
}
/**
 * Facade-level name of the runtime `beforeToolCall` hook.
 *
 * Kept for the frozen public surface (`./index.ts` re-exports it). The Pi SDK installs hooks with
 * the richer `BeforeToolCallContext` shape (see `createBankingAgent` below); this alias documents the
 * `(toolCallId, toolName, args) → { block, reason }` decision the hook ultimately expresses.
 */
export type BeforeToolCallHook = (
  toolCallId: string,
  toolName: ToolName,
  args: Record<string, unknown>,
) => Promise<{ block: boolean; reason?: string }>;
/**
 * Facade-level name of the runtime `afterToolCall` hook. Kept for the frozen public surface
 * (`./index.ts` re-exports it); the UI stream itself is produced by `./run-turn`.
 */
export type AfterToolCallHook = (
  toolCallId: string,
  toolName: ToolName,
  result: unknown,
) => Promise<void>;
/** Build the Pi Agent for a session (restores AgentState from `options.snapshot` when present). */
export function createBankingAgent(options: BankingAgentOptions): BankingAgentRuntime {
  const config = options.config ?? getConfig();
  const { sessionId, userId } = options;
  const restored = options.snapshot?.agentState;

  /** Current user request, read lazily so it always reflects the live transcript (audit-only). */
  const latestUserRequest = (): string => latestUserText(agent.state.messages);

  // `userId` is SERVER-INJECTED here — never taken from tool args or model text. The planner's node
  // runner is the gateway-authorized execution path, so a gated plan node still parks for a human.
  const registry = createToolRegistry(userId, {
    automaticWriteFence: () => buildAutomaticWriteFence(sessionId),
    submitPlan: {
      sessionId,
      runTool: (toolName, args, ctx) =>
        executeGatedTool({
          sessionId,
          userId,
          toolName,
          args,
          userRequest: latestUserRequest(),
          taskId: ctx.taskId,
          nodeId: ctx.nodeId,
        }),
      ...(options.onPlanUpdate !== undefined ? { onPlanUpdate: options.onPlanUpdate } : {}),
    },
  });

  const { model, streamFn } = resolveProvider(config);
  const systemPrompt = buildSystemPrompt({
    userId,
    toolNames: registry.list().map((tool) => tool.name as ToolName),
  });

  /**
   * THE security chokepoint. Every tool the model proposes is gated here BEFORE it can execute:
   * a blocked (YELLOW/RED, or locked) call returns `{ block: true, reason }`, the SDK emits an error
   * tool-result carrying the opaque block reason, and the gateway has already persisted the
   * `PendingAction` for the human decision. The agent computes NOTHING about permission itself.
   */
  const beforeToolCall = async (
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name as ToolName;
    const args = (context.args ?? context.toolCall.arguments ?? {}) as Record<string, unknown>;

    const auth = await gateway.handleToolCall({
      sessionId,
      userId,
      toolName,
      args,
      userRequest: latestUserRequest(),
    });

    if (auth.evaluation.blocked) {
      return { block: true, reason: auth.blockReason ?? auth.decision.message };
    }
    return undefined;
  };

  /**
   * The UI stream is built by `./run-turn` from the `tool_execution_*` events, so this hook only has
   * to be a valid no-op (returning `undefined` keeps the executed result untouched).
   */
  const afterToolCall = async (
    _context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> => undefined;

  /** Listeners registered by THIS module, removed by `dispose()`. */
  const unsubscribers: Array<() => void> = [];

  const agent = new Agent({
    sessionId,
    streamFn,
    initialState: {
      systemPrompt,
      model,
      tools: registry.list(),
      messages: normalizeToolResultMessages(restored?.messages ?? []),
    },
    beforeToolCall,
    afterToolCall,
  });

  return {
    agent,
    sessionId,
    userId,
    registry,
    serialize(): SessionSnapshot {
      const now = Date.now();
      return {
        sessionId,
        userId,
        agentState: agent.state,
        transcript: options.snapshot?.transcript ?? [],
        createdAt: options.snapshot?.createdAt ?? now,
        updatedAt: now,
      };
    },
    dispose(): void {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
  };
}
