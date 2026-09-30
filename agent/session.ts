/**
 * session.ts — per-session AgentState + UI transcript store (via `@/lib/db/repositories/session`).
 * Persists under `stateJson`: `agentState` (JSON-serializable pi AgentState used to restore the Agent
 * and to `continue()` after a confirmation) and `transcript` (UI `ChatMessage[]`). Ids via `@/lib/ids`.
 */
import type { AgentState } from '@mariozechner/pi-agent-core';
import type { ChatMessage } from '@/lib/contracts/agent';

export interface SessionSnapshot {
  sessionId: string;
  userId: string;
  agentState: AgentState;
  transcript: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
/** Create a new in-memory session snapshot (not yet persisted); sessionId = newId('sess'). */
export function newSession(userId: string): SessionSnapshot {
  throw new Error('not implemented');
}
/** Load a session snapshot; `null` when absent. */
export function loadSession(sessionId: string): Promise<SessionSnapshot | null> {
  throw new Error('not implemented');
}
/** Persist (upsert) a session snapshot. */
export function saveSession(snapshot: SessionSnapshot): Promise<void> {
  throw new Error('not implemented');
}
/** Load an existing session or create + persist a new one. */
export function getOrCreateSession(userId: string, sessionId?: string): Promise<SessionSnapshot> {
  throw new Error('not implemented');
}
