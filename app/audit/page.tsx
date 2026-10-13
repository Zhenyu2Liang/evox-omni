/**
 * Audit Log — `/audit` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `audit.listAudit({ sessionId })` → `AuditEntry[]` (newest-first)
 *   `audit.getAuditSummary()`        → `AuditSummary` (total / byRisk / byStatus)
 *   Session id: the `banking_session` cookie (`SESSION_COOKIE`).
 *
 * Composes (`@/components` — read-only sibling): `ui/Table` for the audit trail,
 * `ui/Badge` / `ui/StatusBadge` for the summary, `ui/EmptyState` for the zero-row case.
 * Only `mfaResult` is rendered — the mock MFA code is NEVER surfaced.
 */
import { cookies } from 'next/headers';
import { audit } from '@/audit';
import type { AuditSummary } from '@/audit';
import type { AuditEntry, AuditStatus } from '@/lib/contracts/audit';
import type { RiskLevel } from '@/lib/contracts/risk';
import { RISK_LABEL, SESSION_COOKIE } from '@/lib/constants';
import { formatDateTime } from '@/lib/date';
import { getSession } from '@/lib/db/repositories/session';
import { Badge, Card, EmptyState, StatusBadge, Table } from '@/components';
import type { TableColumn } from '@/components';

type BadgeTone = 'neutral' | 'info' | 'success' | 'warn' | 'danger';

/** Display label + badge tone per audit status (presentation mapping only). */
const STATUS_VIEW: Record<AuditStatus, { label: string; tone: BadgeTone }> = {
  allowed: { label: '已放行', tone: 'info' },
  blocked: { label: '已拦截', tone: 'danger' },
  waiting_confirmation: { label: '待确认', tone: 'warn' },
  waiting_verification: { label: '待验证', tone: 'warn' },
  success: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
  locked: { label: '已锁定', tone: 'danger' },
};

const MFA_RESULT_LABEL: Record<'success' | 'failed' | 'not_required', string> = {
  success: '验证通过',
  failed: '验证失败',
  not_required: '无需验证',
};

const yesNo = (value: boolean): string => (value ? '是' : '否');

/** Compact, single-line view of a tool result (resolved facts only — no raw internals). */
function summarizeToolResult(result: unknown): string {
  if (result === undefined || result === null) return '—';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

const COLUMNS: TableColumn<AuditEntry>[] = [
  { key: 'timestamp', header: '时间', render: (e) => formatDateTime(e.timestamp) },
  { key: 'userRequest', header: '用户请求', render: (e) => e.userRequest || '—' },
  { key: 'intent', header: '意图', render: (e) => e.intent || '—' },
  { key: 'toolName', header: '工具', render: (e) => e.toolName },
  { key: 'riskLevel', header: '风险等级', render: (e) => <StatusBadge tier={e.riskLevel} /> },
  { key: 'confirmationRequired', header: '需确认', align: 'center', render: (e) => yesNo(e.confirmationRequired) },
  { key: 'confirmed', header: '已确认', align: 'center', render: (e) => yesNo(e.confirmed) },
  { key: 'mfaRequired', header: '需验证', align: 'center', render: (e) => yesNo(e.mfaRequired) },
  { key: 'mfaResult', header: '验证结果', render: (e) => MFA_RESULT_LABEL[e.mfaResult ?? 'not_required'] },
  { key: 'toolResult', header: '工具结果', render: (e) => summarizeToolResult(e.toolResult) },
  {
    key: 'status',
    header: '状态',
    render: (e) => <Badge tone={STATUS_VIEW[e.status].tone}>{STATUS_VIEW[e.status].label}</Badge>,
  },
];

// Reads the request cookie + live Prisma data, so it must render per request.
export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value ?? '';

  const owner = sessionId ? await getSession(sessionId) : null;
  const filter = { sessionId, userId: owner?.userId };
  const entries: AuditEntry[] = owner ? await audit.listAudit(filter) : [];
  const summary: AuditSummary = owner ? await audit.getAuditSummary(filter) : { total: 0, byRisk: {}, byStatus: {} };

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">审计日志</h1>
        <p className="mt-1 text-sm text-banking-navy">
          最近 {entries.length} 条记录 · 总计 {summary.total} 条
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-2">
        <Badge tone="info">总计 {summary.total}</Badge>
        {(Object.keys(RISK_LABEL) as RiskLevel[]).map((tier) => (
          <StatusBadge key={tier} tier={tier} label={`${RISK_LABEL[tier]} ${summary.byRisk[tier] ?? 0}`} />
        ))}
        {Object.entries(STATUS_VIEW).map(([status, view]) => (
          <Badge key={status} tone={view.tone}>
            {view.label} {summary.byStatus[status] ?? 0}
          </Badge>
        ))}
      </section>

      <Card title="审计明细" description="按时间倒序 · 每次风控决策与授权执行一条记录">
        <Table
          columns={COLUMNS}
          rows={entries}
          rowKey={(row, index) => row.id ?? `${row.timestamp}-${row.toolName}-${index}`}
          empty={
            <EmptyState
              title="暂无审计记录"
              description="在本会话中与 AI 助手交互后，工具调用与风控决策将记录在此。"
            />
          }
        />
      </Card>
    </main>
  );
}
