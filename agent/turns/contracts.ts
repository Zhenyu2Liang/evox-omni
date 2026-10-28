import type { AgentStreamEvent, ChatMessage } from '@/lib/contracts/agent';
import type { AppConfig } from '@/lib/config';
import type { ToolName } from '@/lib/contracts/tools';
import type { FactInput } from '../grounding-facts';
import type { BankingGuidance } from '../banking-guidance';
import type { ModelRuntime } from '../providers/types';
import type { ToolExecutionResult } from '../tools';

export interface RunTurnDeps {
  config?: AppConfig;
  now?: () => number;
  provider?: ModelRuntime;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}

export interface ResumeTurnInput {
  sessionId: string;
  toolResult: ToolExecutionResult;
  toolCallId?: string;
  toolName?: ToolName;
  resultToolName?: ToolName;
  sourceAccountId?: string;
  actionId?: string;
  taskId?: string;
  nodeId?: string;
}

/** Presentation state holds trusted facts separately from provider message content. */
export interface TurnBuffer {
  events: AgentStreamEvent[];
  assistants: ChatMessage[];
  current: ChatMessage | null;
  /** Ordered tool entries are independent of the currently generated prose message. */
  toolMessages: Map<string, ChatMessage>;
  presentationId: string;
  toolOwnerKey?: string;
  /** Original submit-plan entry retained while an authorized workflow resumes. */
  resumedPlanMessage?: ChatMessage;
  factResults: FactInput[];
  /** Prior verified results support follow-up discussion without being new execution evidence. */
  conversationFacts?: FactInput[];
  sourceAccounts: Map<string, string>;
  requestText?: string;
  serverGuidance?: BankingGuidance;
  lastGuidance?: BankingGuidance;
  conversational?: boolean;
  /** Advice permits relevant query authorization, but never a mutation or workflow. */
  advisory?: boolean;
  allowProtocolExamples?: boolean;
  replyPhase?: 'generating' | 'checking' | 'repairing';
  repairingReply?: boolean;
  operationClaim?: boolean;
  balanceClaim?: boolean;
  operationExplanation?: string;
  groundedIds: Set<string>;
}

export interface PlanRelay {
  parkedActionId?: string;
  parkedToolName?: string;
}
