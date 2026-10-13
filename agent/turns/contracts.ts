import type { AgentStreamEvent, ChatMessage } from '@/lib/contracts/agent';
import type { AppConfig } from '@/lib/config';
import type { ToolName } from '@/lib/contracts/tools';
import type { FactInput } from '../grounding-facts';
import type { BankingGuidance, GuidanceField } from '../banking-guidance';
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
  factResults: FactInput[];
  sourceAccounts: Map<string, string>;
  requestText?: string;
  providedFields?: GuidanceField[];
  serverGuidance?: BankingGuidance;
  lastGuidance?: BankingGuidance;
  groundedIds: Set<string>;
}

export interface PlanRelay {
  parkedActionId?: string;
  parkedToolName?: string;
}
