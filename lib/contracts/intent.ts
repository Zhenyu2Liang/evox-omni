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
  id: string;
  revision: number;
  requestText: string;
  latestMessage: string;
  steps: IntentStep[];
}
