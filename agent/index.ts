/**
 * index.ts — the `agent` node facade (public runtime surface). `app/api` routes and `tests/` import
 * ONLY from here.
 */
export { createBankingAgent } from './banking-agent';
export type { BankingAgentOptions, BankingAgentRuntime, BeforeToolCallHook, AfterToolCallHook } from './banking-agent';
export { runTurn, resumeTurn } from './run-turn';
export type { RunTurnDeps, ResumeTurnInput } from './run-turn';
export { confirmAction, verifyAction, cancelAction, executeGatedTool } from './confirmation';
export type { ConfirmationOutcome, ConfirmOptions, GatedToolOutcome } from './confirmation';
export { toCards, errorCard, confirmationCard, mfaCard } from './card-emitter';
export { buildSystemPrompt, HALLUCINATION_RULE } from './system-prompt';
export type { SystemPromptContext } from './system-prompt';
export { newSession, loadSession, saveSession, getOrCreateSession } from './session';
export type { SessionSnapshot } from './session';
export { createToolRegistry } from './tools';
export type { ToolRegistry, ToolExecutionResult } from './tools';
export { resolveModel, providerId } from './providers';
