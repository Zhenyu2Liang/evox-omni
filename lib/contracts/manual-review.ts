/** Human decisions concern workflow only; banking facts still require execution evidence. */
export type ManualResolution = 'stop' | 'retry' | 'resume';
export type ManualHandoffStatus = 'human_review_requested' | 'operator_controlled' | 'resolved';

export interface ManualReviewTarget {
  taskId?: string;
  actionId?: string;
  title: string;
  error: string;
  mayRetry: boolean;
  mayResume?: boolean;
  workflowStatus?: string;
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
  mayResume?: boolean;
  mayStop?: boolean;
  handoffStatus?: ManualHandoffStatus;
  workflowStatus?: string;
}

export interface ManualReviewInbox {
  operatorName: string;
  candidates: ManualReviewTarget[];
  reviews: ManualReviewRecord[];
}
