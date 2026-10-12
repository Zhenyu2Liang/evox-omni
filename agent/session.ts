/**
 * session.ts — per-session AgentState + UI transcript store (via `@/lib/db/repositories/session`).
 * Persists under `stateJson`: `agentState` (JSON-serializable pi AgentState used to restore the Agent
 * and to `continue()` after a confirmation) and `transcript` (UI `ChatMessage[]`). Ids via `@/lib/ids`.
 *
 * Persistence note: the repository (`createSession`) mints the row id itself (Prisma `cuid`);
 * a snapshot's provisional `newId('sess')` cannot be forced into the row. `saveSession` therefore
 * ADOPTS the persisted id back onto the snapshot so subsequent `save`/`load` round-trips are
 * consistent (see `getOrCreateSession`, the canonical create path).
 */
import type { AgentState } from '@earendil-works/pi-agent-core';
import type { ChatMessage } from '@/lib/contracts/agent';
import { newId } from '@/lib/ids';
import { safeParse, toJson } from '@/lib/json';
import { redactSecrets } from '@/lib/sensitive';
import {
  createSession,
  getSession,
  updateSessionState,
} from '@/lib/db/repositories/session';

export interface SessionSnapshot {
  sessionId: string;
  userId: string;
  agentState: AgentState;
  transcript: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** The JSON blob persisted under `stateJson` (everything needed to rebuild a `SessionSnapshot`). */
interface PersistedSession {
  agentState?: AgentState;
  transcript?: ChatMessage[];
  userId?: string;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * A minimal placeholder `AgentState` for a brand-new session.
 *
 * A fully-typed `AgentState` requires a live `Model` and the registered `AgentTool`s, neither of
 * which exist before `banking-agent.createBankingAgent` runs. `banking-agent.serialize()` replaces
 * this with the real state; the placeholder only exists so `newSession` can return a well-formed
 * snapshot. The cast is deliberate (a `Model` cannot be fabricated here).
 */
function placeholderAgentState(): AgentState {
  return {
    systemPrompt: '',
    model: undefined,
    thinkingLevel: 'off',
    tools: [],
    messages: [],
    isStreaming: false,
    pendingToolCalls: new Set<string>(),
  } as unknown as AgentState;
}

/** Serialize the parts of a snapshot that live in `stateJson`. */
function serialize(snapshot: SessionSnapshot): string {
  const persisted: PersistedSession = {
    agentState: snapshot.agentState,
    transcript: snapshot.transcript,
    userId: snapshot.userId,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
  return toJson(redactSecrets(persisted));
}

/** Create a new in-memory session snapshot (not yet persisted); sessionId = newId('sess'). */
export function newSession(userId: string): SessionSnapshot {
  const now = Date.now();
  return {
    sessionId: newId('sess'),
    userId,
    agentState: placeholderAgentState(),
    transcript: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Load a session snapshot; `null` when absent. */
export async function loadSession(sessionId: string): Promise<SessionSnapshot | null> {
  const row = await getSession(sessionId);
  if (row === null) return null;

  const persisted = redactSecrets(safeParse<PersistedSession>(row.stateJson, {})) as PersistedSession;
  return {
    sessionId: row.id,
    userId: row.userId,
    agentState: persisted.agentState ?? placeholderAgentState(),
    transcript: persisted.transcript ?? [],
    createdAt: persisted.createdAt ?? row.createdAt.getTime(),
    updatedAt: persisted.updatedAt ?? row.updatedAt.getTime(),
  };
}

/** Persist (upsert) a session snapshot. */
export async function saveSession(snapshot: SessionSnapshot): Promise<void> {
  const updatedAt = Date.now();
  const stateJson = serialize({ ...snapshot, updatedAt });

  const existing = await getSession(snapshot.sessionId);
  if (existing !== null) {
    await updateSessionState(snapshot.sessionId, stateJson);
    snapshot.updatedAt = updatedAt;
    return;
  }

  // New session: the repository mints the row id, so adopt the persisted identity onto the
  // snapshot — otherwise a later save/load with the provisional id would not find the row.
  const created = await createSession({ userId: snapshot.userId, stateJson });
  snapshot.sessionId = created.id;
  snapshot.createdAt = created.createdAt.getTime();
  snapshot.updatedAt = updatedAt;
}

/** Load an existing session or create + persist a new one. */
export async function getOrCreateSession(
  userId: string,
  sessionId?: string,
): Promise<SessionSnapshot> {
  if (sessionId !== undefined && sessionId !== '') {
    const existing = await loadSession(sessionId);
    if (existing !== null) return existing;
  }

  const snapshot = newSession(userId);
  await saveSession(snapshot); // adopts the persisted row id on the returned snapshot
  return snapshot;
}
