/** Human decisions concern workflow only; banking facts still require execution evidence. */
export type ManualResolution = 'stop' | 'retry';

export interface ManualReviewTarget {
  taskId?: string;
  actionId?: string;
  title: string;
  error: string;
  mayRetry: boolean;
}

export interface ManualReviewRecord {
  id: string;
  taskId?: string;
  actionId?: string;
  title: string;
  reason: string;
  status: 'open' | 'closed';
  operatorName: string;
  notes?: string;
  resolution?: ManualResolution;
  createdAt: string;
  resolvedAt?: string;
  mayRetry: boolean;
}

export interface ManualReviewInbox {
  operatorName: string;
  candidates: ManualReviewTarget[];
  reviews: ManualReviewRecord[];
}
