import { prisma } from '@/lib/db/client';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { validateScheduledPayload } from '@/lib/contracts/scheduled-command';
import { formatCNY } from '@/lib/money';
import { safeParse } from '@/lib/json';
import { resolveTransferRecipient } from './recipient-resolution';

/** Display owned banking references as business facts, never raw command JSON. */
export async function scheduledTaskFields(userId: string, kind: string, raw: unknown): Promise<PendingActionSummary['fields']> {
  try {
    const payload = validateScheduledPayload(kind, raw as Record<string, unknown> | undefined);
    if (kind === 'REMINDER') return typeof payload?.note === 'string' && payload.note.trim()
      ? [{ label: '任务内容', value: payload.note }] : [];
    const recipient = await resolveTransferRecipient(userId, payload!);
    const sourceId = payload!.sourceAccountId;
    const account = await prisma.account.findFirst({ where: { userId,
      ...(typeof sourceId === 'string' ? { id: sourceId } : { type: 'CHECKING' }) },
      select: { name: true, number: true } });
    return [
      { label: '收款人', value: recipient.status === 'resolved' ? recipient.contact.name : '收款人待核对' },
      { label: '金额', value: formatCNY(String(payload!.amount)) },
      { label: '付款账户', value: account ? `${account.name} · ${account.number}` : '账户待核对' },
      ...(typeof payload!.remark === 'string' && payload!.remark.trim() ? [{ label: '备注', value: payload!.remark }] : []),
    ];
  } catch {
    return [{ label: '任务内容', value: '任务内容待核对' }];
  }
}

/** Read-only compatibility for old confirmation snapshots; authorization data stays untouched. */
export async function projectScheduledSummary(userId: string, summary: PendingActionSummary): Promise<PendingActionSummary> {
  if (summary.toolName !== 'create_scheduled_task') return summary;
  const content = summary.fields.find(field => field.label === '任务内容');
  const kind = summary.fields.find(field => field.label === '任务类型')?.value;
  if (!content || (kind !== 'TRANSFER' && kind !== 'PAYMENT') || typeof content.value !== 'string' || !content.value.trimStart().startsWith('{')) return summary;
  const payload = safeParse<unknown>(content.value, undefined);
  const fields = await scheduledTaskFields(userId, kind, payload);
  return { ...summary, fields: summary.fields.flatMap(field => field === content ? fields : [field]) };
}
