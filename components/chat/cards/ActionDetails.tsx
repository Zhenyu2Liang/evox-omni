'use client';

import type { PendingActionSummary } from '@/lib/contracts/security';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { isActionAmountField, localizeActionFieldLabel, localizeActionFieldValue } from '@/lib/i18n/display';
import { Money } from '../../ui';

/** The immutable business details shared by requests and historical authorization records. */
export function ActionDetails({ action }: { action: Pick<PendingActionSummary, 'fields' | 'amount'> }) {
  const { t } = useI18n();
  return <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
    {action.fields.map((field, index) => <div key={`${field.label}-${index}`} className="flex min-w-0 items-start justify-between gap-3">
      <dt className="shrink-0 text-banking-navy/70">{localizeActionFieldLabel(field.label, t)}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-banking-deep">{localizeActionFieldValue(field, t)}</dd>
    </div>)}
    {typeof action.amount === 'string' && !action.fields.some(field => isActionAmountField(field.label)) ?
      <div className="flex items-center justify-between gap-3">
        <dt className="text-banking-navy/70">{t('cards.amount')}</dt>
        <dd className="font-semibold text-banking-deep"><Money amount={action.amount} /></dd>
      </div> : null}
  </dl>;
}
