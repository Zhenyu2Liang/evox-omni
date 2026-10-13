/**
 * tests/helpers/faux-agent.ts — build a REAL Pi Agent driven by a SCRIPTED model.
 *
 * Scenario tests exercise the full pipeline (Agent runtime → registered banking tools →
 * Security Gateway `beforeToolCall` → Banking SDK → audit) while keeping the MODEL
 * deterministic and offline, via `fauxProvider()` (from `@earendil-works/pi-ai`) and
 * `LLM_MODE=mock`. Only the model is scripted — the tools, the security chokepoint and the
 * DB are the production ones. This is what makes the 12 demo scenarios provable without a
 * network or an API key.
 *
 * The agent is built with the SAME wiring as `@/agent/banking-agent.ts` (constructor path:
 * `new Agent({ initialState, streamFn, beforeToolCall, afterToolCall, sessionId })`), differing ONLY in the
 * model (a scripted faux provider instead of the live/mock provider resolved from config).
 *
 * Key SDK facts this helper relies on (pi-agent-core 1.1.0):
 *   - `new Agent({ initialState, streamFn, beforeToolCall, afterToolCall, sessionId, ... })`.
 *   - `agent.prompt(input)` / `agent.continue()` settle when the turn ends.
 *   - `agent.subscribe(listener)` streams `AgentEvent`s.
 *   - `beforeToolCall` returning `{ block: true, reason }` prevents execution (the security gate).
 *   - `fauxProvider().setResponses(steps)` REPLACES the queue; ONE step is consumed per
 *     model call (an empty queue ⇒ an error assistant message ⇒ `stopReason:'error'`).
 */
import { Agent } from '@earendil-works/pi-agent-core';
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';
import { createModels, fauxAssistantMessage, fauxToolCall, fauxProvider } from '@earendil-works/pi-ai';
import type { FauxProviderHandle, FauxResponseStep, JsonObject } from '@earendil-works/pi-ai';
import type { ToolName } from '@/lib/contracts/tools';
import { newId } from '@/lib/ids';
import { createToolRegistry } from '@/agent/tools';
import { executeGatedTool } from '@/agent/confirmation';
import { buildSystemPrompt } from '@/agent/system-prompt';
import { security } from '@/security';
import { DEMO_USER_ID } from './fixtures';

/** One proposed tool call in a scripted model turn. */
export interface FauxToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** One scripted model turn: emit text, or propose a tool call, or produce the final reply. */
export type FauxStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolCall: FauxToolCall }
  | { kind: 'final'; text: string };

export interface FauxAgentOptions {
  /** Ordered script replayed one step per model turn. */
  script: FauxStep[];
  /** Registered banking tools; defaults to the `./agent` tool registry (all 26 tools incl. submit_plan). */
  tools?: AgentTool<any>[];
  /** System prompt; defaults to the `./agent` banking system prompt. */
  systemPrompt?: string;
  /** Session id (use `scenario.newSessionId()` for breaker isolation per test). */
  sessionId?: string;
  /** Override the model; defaults to the faux/scripted provider. */
  registerModel?: boolean;
}

/** Hidden (non-enumerable) property holding the faux registration on the returned agent. */
const FAUX_REGISTRATION = Symbol.for('tests/helpers/faux-agent/registration');

/** Translate one scripted `FauxStep` into a faux provider response step. */
function stepToFaux(step: FauxStep): FauxResponseStep {
  if (step.kind === 'tool') {
    // A `toolCall` content block (NOT the stopReason) is what makes the agent loop execute a tool.
    return fauxAssistantMessage([fauxToolCall(step.toolCall.tool, JSON.parse(JSON.stringify(step.toolCall.args)) as JsonObject)], {
      stopReason: 'toolUse',
    });
  }
  return fauxAssistantMessage(step.text);
}

/**
 * Construct a Pi `Agent` wired with the scripted model, the banking tools and the production
 * security `beforeToolCall`. Returns a ready-to-`prompt()` agent.
 */
export function buildFauxAgent(options: FauxAgentOptions): Agent {
  const sessionId = options.sessionId ?? newId('sess');
  const userId = DEMO_USER_ID;

  const registration = fauxProvider();
  const models = createModels();
  models.setProvider(registration.provider);
  registration.setResponses(options.script.map(stepToFaux));
  let agent!: Agent;
  const userRequest = (): string => {
    const message = [...agent.state.messages].reverse().find(candidate => candidate.role === 'user');
    if (!message || message.role !== 'user') return '';
    if (typeof message.content === 'string') return message.content;
    return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  };

  // `userId` is SERVER-INJECTED (never from model text / tool args). `submit_plan` runs its DAG
  // through the gateway-authorized path so a gated plan node still parks for a human.
  const registry = createToolRegistry(userId, {
    submitPlan: {
      sessionId,
      userRequest,
      runTool: (toolName, args, ctx) =>
        executeGatedTool({ sessionId, userId, toolName, args, userRequest: userRequest(), ...ctx }),
    },
  });

  const tools = options.tools ?? registry.list();
  const systemPrompt =
    options.systemPrompt ??
    buildSystemPrompt({ userId, toolNames: tools.map((tool) => tool.name as ToolName) });

  const gateway = security.gateway.securityGateway;

  /** THE security chokepoint — identical to the production `beforeToolCall`. */
  const beforeToolCall = async (
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name as ToolName;
    const args = (context.args ?? context.toolCall.arguments ?? {}) as Record<string, unknown>;
    const auth = await gateway.handleToolCall({ sessionId, userId, toolName, args, userRequest: userRequest() });
    if (auth.evaluation.blocked) {
      return { block: true, reason: auth.blockReason ?? auth.decision.message };
    }
    return undefined;
  };

  const afterToolCall = async (
    _context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> => undefined;

  agent = new Agent({
    sessionId,
    streamFn: models.streamSimple.bind(models),
    initialState: {
      systemPrompt,
      model: registration.getModel(),
      tools,
      messages: [],
    },
    beforeToolCall,
    afterToolCall,
  });

  // Non-enumerable: `scenario.ts` appends continuation responses via `fauxRegistrationOf`.
  Object.defineProperty(agent, FAUX_REGISTRATION, {
    value: registration,
    enumerable: false,
    configurable: true,
  });

  return agent;
}

/** The faux provider registration attached to an agent built by `buildFauxAgent` (else `undefined`). */
export function fauxRegistrationOf(agent: Agent): FauxProviderHandle | undefined {
  return (agent as unknown as Record<symbol, FauxProviderHandle | undefined>)[
    FAUX_REGISTRATION
  ];
}

/* ------------------------------------------------------------------ script builders */

export const text = (value: string): FauxStep => ({ kind: 'text', text: value });
export const tool = (name: string, args: Record<string, unknown>): FauxStep => ({
  kind: 'tool',
  toolCall: { tool: name, args },
});
export const final = (value: string): FauxStep => ({ kind: 'final', text: value });

/** Convenience: a one-tool-call turn followed by a narration turn. */
export function callThen(text: string, name: string, args: Record<string, unknown>): FauxStep[] {
  return [tool(name, args), final(text)];
}
