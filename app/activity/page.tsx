import { listOperationHistory } from '@/audit';
import { requireIdentity } from '@/app/api/_lib/session';
import { getServerI18n } from '@/lib/i18n/server';
import { ActivityHistory } from './ActivityHistory';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const { t } = await getServerI18n();
  const { sessionId, userId } = await requireIdentity();
  const entries = await listOperationHistory({ sessionId, userId });
  return <main className="mx-auto w-full min-w-0 max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
    <header><h1 className="bank-page-heading text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.activity.title')}</h1>
      <p className="mt-1 text-sm text-banking-navy">{t('pages.activity.summary', { count: entries.length })}</p></header>
    <ActivityHistory entries={entries} t={t} />
  </main>;
}
