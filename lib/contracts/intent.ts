/** A model interpretation is scoped to one user turn and never grants banking authorization. */
export type TurnPurpose = 'undecided' | 'conversation' | 'advice' | 'query' | 'operation';

export interface IntentStep {
  key: string;
  tool: string;
}

export interface ConversationIntent {
  purpose: TurnPurpose;
  allowProtocolExamples?: boolean;
  workflow?: boolean;
  /** A write declaration is not ready until the model explicitly resolves required user choices. */
  needsInput?: boolean;
  /** Server-owned missing-input prerequisite, never granted by a model declaration. */
  requiredInput?: 'scheduled_time';
  id: string;
  revision: number;
  requestText: string;
  latestMessage: string;
  steps: IntentStep[];
}
