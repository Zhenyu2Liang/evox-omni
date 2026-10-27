/**
 * Developer audit log — `/audit` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `audit.listAudit({ sessionId })` → `AuditEntry[]` (newest-first)
 *   `audit.getAuditSummary(scope)`   → `AuditSummary` (total / byRisk / byStatus)
 *   Scope: the configured demo user and fixed demo session from `requireIdentity`.
 *
 * Composes (`@/components` — read-only sibling): `ui/Table` for the audit trail,
 * `ui/Badge` / `ui/StatusBadge` for the summary, `ui/EmptyState` for the zero-row case.
 * Only `mfaResult` is rendered — the mock MFA code is NEVER surfaced.
 */
import { audit } from '@/audit';
import type { AuditSummary } from '@/audit';
import type { AuditEntry, AuditStatus } from '@/lib/contracts/audit';
import type { RiskLevel } from '@/lib/contracts/risk';
import { requireIdentity } from '@/app/api/_lib/session';
import { formatDateTime } from '@/lib/date';
import { Badge, Card, EmptyState, StatusBadge, Table } from '@/components';
import type { TableColumn } from '@/components';
import { getServerI18n } from '@/lib/i18n/server';
import { localizeActionTitle, localizeToolLabel } from '@/lib/i18n/display';
import { getServerDeveloperMode } from '@/lib/developer-mode/server';
import { DeveloperModeRequired } from '../_components/DeveloperTools';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warn' | 'danger';

/** Compact preview of developer-only execution evidence. */
function summarizeToolResult(result: unknown): string {
  if (result === undefined || result === null) return '—';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

// Reads live audit data and language preference; render on demand instead of at build.
export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  if (!await getServerDeveloperMode()) {
    return <main className="mx-auto w-full min-w-0 max-w-6xl p-4 sm:p-6 lg:p-8"><DeveloperModeRequired titleKey="app.audit" /></main>;
  }
  const { t } = await getServerI18n();
  const { sessionId, userId } = await requireIdentity();
  const filter = { sessionId, userId };
  const entries: AuditEntry[] = await audit.listAudit(filter);
  const summary: AuditSummary = await audit.getAuditSummary(filter);

  const statusView: Record<AuditStatus, { label: string; tone: BadgeTone }> = {
    allowed: { label: t('pages.audit.status.allowed'), tone: 'info' },
    blocked: { label: t('pages.audit.status.blocked'), tone: 'danger' },
    waiting_confirmation: { label: t('pages.audit.status.waitingConfirmation'), tone: 'warn' },
    waiting_verification: { label: t('pages.audit.status.waitingVerification'), tone: 'warn' },
    success: { label: t('pages.audit.status.success'), tone: 'success' },
    failed: { label: t('pages.audit.status.failed'), tone: 'danger' },
    cancelled: { label: t('pages.audit.status.cancelled'), tone: 'neutral' },
    locked: { label: t('pages.audit.status.locked'), tone: 'danger' },
  };
  const verificationLabels = {
    success: t('pages.audit.verification.success'),
    failed: t('pages.audit.verification.failed'),
    not_required: t('pages.audit.verification.notRequired'),
  };
  const riskLabels: Record<RiskLevel, string> = {
    GREEN: t('pages.audit.risk.green'),
    YELLOW: t('pages.audit.risk.yellow'),
    RED: t('pages.audit.risk.red'),
  };
  const yesNo = (value: boolean): string => t(value ? 'pages.audit.yes' : 'pages.audit.no');
  const columns: TableColumn<AuditEntry>[] = [
    { key: 'timestamp', header: t('pages.audit.column.time'), render: (entry) => formatDateTime(entry.timestamp) },
    { key: 'userRequest', header: t('pages.audit.column.request'), render: (entry) => entry.userRequest || '—' },
    { key: 'intent', header: t('pages.audit.column.intent'), render: (entry) => entry.intent ? localizeActionTitle(entry.intent, t) : '—' },
    { key: 'toolName', header: t('pages.audit.column.tool'), render: (entry) => <><span>{localizeToolLabel(entry.toolName, t)}</span><code className="block text-banking-caption">{entry.toolName}</code></> },
    { key: 'riskLevel', header: t('pages.audit.column.risk'), render: (entry) => <StatusBadge tier={entry.riskLevel} /> },
    { key: 'confirmationRequired', header: t('pages.audit.column.confirmationRequired'), align: 'center', render: (entry) => yesNo(entry.confirmationRequired) },
    { key: 'confirmed', header: t('pages.audit.column.confirmed'), align: 'center', render: (entry) => yesNo(entry.confirmed) },
    { key: 'mfaRequired', header: t('pages.audit.column.verificationRequired'), align: 'center', render: (entry) => yesNo(entry.mfaRequired) },
    { key: 'mfaResult', header: t('pages.audit.column.verificationResult'), render: (entry) =>
      entry.mfaResult ? verificationLabels[entry.mfaResult] : entry.mfaRequired ? '—' : verificationLabels.not_required },
    { key: 'toolResult', header: t('pages.audit.column.toolResult'), render: (entry) => summarizeToolResult(entry.toolResult) },
    { key: 'toolArgs', header: t('pages.audit.column.toolArgs'), render: (entry) => <details><summary>{t('pages.audit.inspect')}</summary><pre className="max-h-64 max-w-xs overflow-auto whitespace-pre-wrap break-all text-banking-caption">{JSON.stringify({ args: entry.toolArgs, result: entry.toolResult, detail: entry.detail, taskId: entry.taskId, nodeId: entry.nodeId }, null, 2)}</pre></details> },
    {
      key: 'status',
      header: t('pages.audit.column.status'),
      render: (entry) => <Badge tone={statusView[entry.status].tone}>{statusView[entry.status].label}</Badge>,
    },
  ];

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.audit.title')}</h1>
        <p className="mt-1 text-sm text-banking-navy">
          {t('pages.audit.summary', { recent: entries.length, total: summary.total })}
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-2">
        <Badge tone="info">{t('pages.audit.total', { count: summary.total })}</Badge>
        {(Object.keys(riskLabels) as RiskLevel[]).map((tier) => (
          <StatusBadge key={tier} tier={tier} label={`${riskLabels[tier]} ${summary.byRisk[tier] ?? 0}`} />
        ))}
        {Object.entries(statusView).map(([status, view]) => (
          <Badge key={status} tone={view.tone}>
            {view.label} {summary.byStatus[status] ?? 0}
          </Badge>
        ))}
      </section>

      <Card title={t('pages.audit.detailTitle')} description={t('pages.audit.detailDescription')}>
        <div className="min-w-0 overflow-x-auto" data-developer-audit="true"><Table
          columns={columns}
          rows={entries}
          rowKey={(row, index) => row.id ?? `${row.timestamp}-${row.toolName}-${index}`}
          empty={
            <EmptyState
              title={t('pages.audit.emptyTitle')}
              description={t('pages.audit.emptyDescription')}
            />
          }
        /></div>
      </Card>
    </main>
  );
}
