/** Trusted user intent accumulated across clarification turns. */
export interface IntentTurn {
  revision: number;
  text: string;
  receivedAt: number;
}

export interface IntentStep {
  key: string;
  tool: string;
  sourceText: string;
  requestText: string;
  amount?: string;
  recipient?: string;
  requiresClarification: boolean;
}

export interface IntentCondition {
  metric: 'spending';
  category?: string;
  period: { kind: 'month'; relative?: 'current' | 'previous'; month?: string };
  operator: '>' | '>=' | '<' | '<=';
  threshold: string;
  sourceText: string;
}

export interface ConversationIntent {
  id: string;
  revision: number;
  status: 'draft' | 'ready' | 'submitted';
  requestText: string;
  latestMessage: string;
  turns: IntentTurn[];
  steps: IntentStep[];
  conditions: IntentCondition[];
  reference: { recipient?: string; amount?: string };
  createdAt: number;
  updatedAt: number;
}
