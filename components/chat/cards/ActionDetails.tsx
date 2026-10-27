'use client';

import type { PendingActionSummary } from '@/lib/contracts/security';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import {
  isActionAmountField,
  isActionSettlementAmountField,
  isRedemptionNetValueSnapshot,
  isSimulatedNoneFeeField,
  localizeActionFieldLabel,
  localizeActionFieldValue,
} from '@/lib/i18n/display';
import { Money } from '../../ui';

/** The immutable business details shared by requests and historical authorization records. */
export function ActionDetails({ action }: { action: Pick<PendingActionSummary, 'fields' | 'amount'> }) {
  const { t } = useI18n();
  // A redemption snapshot quotes shares × execution net value at park time. The rows below show those
  // snapshot values verbatim (never a fresh quote), so the formula and the reconfirm rule are stated.
  const redemption = isRedemptionNetValueSnapshot(action.fields);
  const simulatedNoneFee = action.fields.some(field => isSimulatedNoneFeeField(field));
  const amountInFields = action.fields.some(field => isActionAmountField(field.label)
    || isActionSettlementAmountField(field.label));
  return <div className="space-y-2">
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {action.fields.map((field, index) => <div key={`${field.label}-${index}`} className="flex min-w-0 items-start justify-between gap-3">
        <dt className="shrink-0 text-banking-navy">{localizeActionFieldLabel(field.label, t)}</dt>
        <dd className="min-w-0 break-words text-right font-medium text-banking-deep">{localizeActionFieldValue(field, t)}</dd>
      </div>)}
      {typeof action.amount === 'string' && !amountInFields ?
        <div className="flex items-center justify-between gap-3">
          <dt className="text-banking-navy">{t('cards.amount')}</dt>
          <dd className="font-semibold text-banking-deep"><Money amount={action.amount} /></dd>
        </div> : null}
    </dl>
    {redemption ? <div className="space-y-1 text-xs leading-relaxed text-banking-navy">
      <p>{t('chat.value.settlementFormula')}</p>
      {simulatedNoneFee ? <p>{t('chat.value.feeRuleSimulatedNone')}</p> : null}
      <p>{t('chat.value.reconfirmOnChange')}</p>
    </div> : null}
  </div>;
}
