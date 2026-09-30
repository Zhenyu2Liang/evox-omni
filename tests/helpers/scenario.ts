/**
 * tests/helpers/scenario.ts — drive a full agent session turn and collect its events.
 *
 * This is the harness the `tests/scenarios/*` specs use to prove the 12 demo scenarios
 * end-to-end. It wraps a `FauxAgent` (`./faux-agent`) and mirrors the real two-phase flow
 * of `POST /api/chat` + `POST /api/actions/:id/{confirm|verify|cancel}` WITHOUT going through
 * Next.js HTTP — it calls the same agent-runtime + security-gateway + SDK functions the routes
 * call, so the assertions target real behaviour, not a mock.
 *
 * STATUS: documented STUB — signatures frozen; implementation lands in Phase 2 once `./agent`
 * and `./audit` are implemented.
 *
 * Two phases (see root CONTEXT.md):
 *   1. `runTurn()` — prompt the agent; GREEN tools execute inline, YELLOW/RED tools are BLOCKED
 *      by `beforeToolCall`, a `PendingAction` is persisted, and a `confirmation_required` /
 *      `mfa_required` event is surfaced.
 *   2. `confirmAction()` / `verifyAction()` — a HUMAN decision executes the ORIGINAL validated
 *      args through the gateway's authorized path, then `agent.continue()` narrates the outcome.
 */
import type {
  AgentStreamEvent,
  ChatCard,
  PendingActionSummary,
  TaskPlan,
  ToolEventView,
} from '@/lib/contracts/agent';

/** Everything a spec needs to assert about one completed agent turn. */
export interface ScenarioResult {
  sessionId: string;
  /** Raw ordered stream events (never contains chain-of-thought — UI contract). */
  events: AgentStreamEvent[];
  /** Concatenated assistant text of the turn. */
  text: string;
  /** Tool lifecycle events (started/success/error/blocked). */
  toolEvents: ToolEventView[];
  /** Structured cards surfaced to the UI (balance/confirmation/mfa/plan/…). */
  cards: ChatCard[];
  /** Present when the turn ended awaiting a YELLOW/RED human decision. */
  confirmation?: { actionId: string; action: PendingActionSummary };
  /** Present when the turn ended awaiting MFA (RED). */
  mfa?: { actionId: string; hint?: string };
  /** Present when a plan was submitted/updated. */
  plan?: TaskPlan;
  /** Present when the turn surfaced an error. */
  error?: string;
}

export interface RunTurnInput {
  sessionId: string;
  message: string;
  /** Agent instance (usually from `faux-agent.buildFauxAgent`). */
  agent: import('@mariozechner/pi-agent-core').Agent;
}

/** Send one user message and collect the resulting turn. */
export async function runTurn(_input: RunTurnInput): Promise<ScenarioResult> {
  throw new Error('not implemented');
}

/**
 * Confirm a pending YELLOW (or RED-after-MFA) action and drive the agent to narrate the
 * factual outcome. Returns the post-decision turn's collected result.
 */
export async function confirmAction(
  _agent: import('@mariozechner/pi-agent-core').Agent,
  _actionId: string,
): Promise<ScenarioResult> {
  throw new Error('not implemented');
}

/** Submit an MFA code for a RED action and drive the agent to narrate the outcome. */
export async function verifyAction(
  _agent: import('@mariozechner/pi-agent-core').Agent,
  _actionId: string,
  _code: string,
): Promise<ScenarioResult> {
  throw new Error('not implemented');
}

/** Cancel a pending action; no execution occurs. */
export async function cancelAction(
  _agent: import('@mariozechner/pi-agent-core').Agent,
  _actionId: string,
): Promise<ScenarioResult> {
  throw new Error('not implemented');
}

/* ---------------------------------------------------------------------------- utils */

/**
 * A unique session id per test — REQUIRED for circuit-breaker isolation (breaker state is
 * in-process keyed by sessionId; the lock from Test 10 must not leak into other specs).
 */
export function newSessionId(prefix = 'sess'): string {
  throw new Error('not implemented');
}

/** Attach a listener that captures every `AgentStreamEvent` into an array (and detaches on return). */
export function collectEvents(
  _agent: import('@mariozechner/pi-agent-core').Agent,
): { events: AgentStreamEvent[]; detach: () => void } {
  throw new Error('not implemented');
}

/** Filter helpers for readable assertions. */
export function toolEventsOf(res: ScenarioResult, toolName: string): ToolEventView[] {
  throw new Error('not implemented');
}

export function cardsOfType<T extends ChatCard['type']>(
  res: ScenarioResult,
  type: T,
): Extract<ChatCard, { type: T }>[] {
  throw new Error('not implemented');
}
