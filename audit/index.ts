/**
 * Audit facade — the public entry point for the `./audit` node.
 *
 * Consumed by the Security Gateway (write path: gateway decisions + gated executions), the
 * agent layer, and the API read routes. Import the facade object `audit` OR the individual
 * functions directly; both expose the same node API.
 */
import { recordAudit, listAudit, getAuditSummary } from './audit-logger';
import { recordSecurityEvent, listSecurityEvents, getSecurityStatus } from './security-events';
import { listOperationHistory } from './operation-history';

export { recordAudit, listAudit, getAuditSummary };
export { recordSecurityEvent, listSecurityEvents, getSecurityStatus };
export { listOperationHistory };

export type { AuditFilter, AuditSummary } from './audit-logger';
export type {
  SecurityEventFilter,
  SecurityStatus,
  SecurityStatusOptions,
  BreakerLookup,
  RecordSecurityEventOptions,
} from './security-events';

/** Single object collecting the node's public functions. */
export const audit = {
  recordAudit,
  listAudit,
  getAuditSummary,
  recordSecurityEvent,
  listSecurityEvents,
  getSecurityStatus,
  listOperationHistory,
};
