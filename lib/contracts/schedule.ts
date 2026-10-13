export interface ReminderNotification {
  id: string;
  scheduledTaskId: string;
  message: string;
  createdAt: number;
}

export interface ScheduledDispatchSummary {
  scheduledTaskId: string;
  status: ScheduledTaskStatus;
  workflowId?: string;
  pendingActionId?: string;
  notificationId?: string;
  error?: string;
}

export interface ScheduleTickResult {
  evaluatedAt: number;
  dispatches: ScheduledDispatchSummary[];
}
import type { ScheduledTaskStatus, ScheduledTaskView } from '@/banking-sdk/types';


export interface ScheduleInbox {
  tasks: ScheduledTaskView[];
  notifications: ReminderNotification[];
}
