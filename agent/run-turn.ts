/**
 * run-turn.ts — one chat turn + the confirmation resume.
 * `runTurn`: resolve/create session, injection scan (security.injection), build runtime
 * (`createBankingAgent`), subscribe to pi AgentEvents and map them to AgentStreamEvents (mapping
 * table in ../CONTEXT.md), prompt the agent, persist the session, return the collected events.
 * `resumeTurn`: inject a REAL tool result and call `agent.continue()` so the model narrates only the
 * factual outcome. NO chain-of-thought is emitted — only task steps / tool status / results.
 */
import type { ChatTurnRequest, ChatTurnResponse } from '@/lib/contracts/agent';
import type { AppConfig } from '@/lib/config';
import type { ToolExecutionResult } from './tools';

export interface RunTurnDeps { config?: AppConfig; now?: () => number; }
export interface ResumeTurnInput {
  sessionId: string;
  toolResult: ToolExecutionResult;
  toolCallId?: string;
}
/** Run one agent turn; returns the stream events emitted during it. */
export function runTurn(req: ChatTurnRequest, deps?: RunTurnDeps): Promise<ChatTurnResponse> {
  throw new Error('not implemented');
}
/** Resume a session after a human confirmation: inject the real tool result and `agent.continue()`. */
export function resumeTurn(input: ResumeTurnInput, deps?: RunTurnDeps): Promise<ChatTurnResponse> {
  throw new Error('not implemented');
}
