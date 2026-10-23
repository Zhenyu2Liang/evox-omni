'use client';

/**
 * HoldingFacts — the 净值 + 份额 facts of one holding, derived only from the `HoldingView` DTO.
 *
 * Every number is SDK-derived (shares × latest net value, unrealized / realized return) and is
 * never recomputed here: presentation must agree with the booked and estimated values the server
 * reported. A fact the SDK could not derive renders the explicit "insufficient history" text
 * instead of a fabricated zero, and the additional purchase amounts never appear as a return.
 */
import type { HoldingView } from '@/banking-sdk';
import { Money } from '../ui/Money';
import { DecimalMoney } from '../ui/DecimalMoney';
import { formatDecimalFixed, signedRateToPercent } from '@/lib/decimal';
import { formatBusinessDate } from '@/lib/date';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey, Translator } from '@/lib/i18n/shared';

/** Layout variant: the tile keeps sibling spans (the e2e row reader pairs them), the card uses dt/dd. */
export type HoldingFactsLayout = 'tile' | 'card';

type FactValue =
  | { kind: 'money'; amount: string }
  | { kind: 'decimal'; amount: string; signed?: boolean }
  | { kind: 'text'; text: string };

interface HoldingFact {
  key: string;
  labelKey: MessageKey;
  value: FactValue;
}

/**
 * True when the SDK values this holding by shares × latest net value.
 *
 * The flag is present whenever the server had enough history to value the holding (`NET_VALUE`), to
 * estimate it (`MIGRATED_ESTIMATE`) or to state that history is insufficient.
 */
export function usesNetValueModel(holding: HoldingView): boolean {
  return holding.valueBasis !== undefined
    || holding.shares !== undefined
    || holding.latestNetValue !== undefined
    || holding.cumulativeProfit !== undefined;
}

/** `valueBasis` → its label; `NET_VALUE` is the normal basis and carries no extra badge. */
export function valueBasisLabelKey(holding: HoldingView): MessageKey | undefined {
  if (holding.valueBasis === 'MIGRATED_ESTIMATE') return 'business.investments.valueBasis.migrated';
  if (holding.valueBasis === 'HISTORICAL_SNAPSHOT') return 'business.investments.valueBasis.snapshot';
  if (holding.valueBasis === 'HISTORICAL_DATA_INSUFFICIENT') return 'business.investments.valueBasis.insufficient';
  return undefined;
}

/** The seven holding facts. Missing values stay explicit — a zero would read as a real figure. */
function buildFacts(holding: HoldingView, t: Translator): HoldingFact[] {
  const insufficient: FactValue = { kind: 'text', text: t('business.investments.insufficient') };
  if (!usesNetValueModel(holding)) {
    const legacy: HoldingFact[] = [];
    if (holding.marketValue !== undefined) {
      legacy.push({ key: 'marketValue', labelKey: 'business.investments.marketValue',
        value: { kind: 'decimal', amount: holding.marketValue } });
    }
    if (holding.profit !== undefined) {
      legacy.push({ key: 'profit', labelKey: 'business.investments.profit',
        value: { kind: 'decimal', amount: holding.profit, signed: true } });
    }
    return legacy;
  }
  const { shares, latestNetValue, latestNetValueDate, profitRate } = holding;
  return [
    { key: 'shares', labelKey: 'business.investments.shares', value: shares === undefined
      ? insufficient
      : { kind: 'text', text: `${formatDecimalFixed(shares, 6)} ${t('business.investments.units.shares')}` } },
    { key: 'netValue', labelKey: 'business.investments.netValue', value: latestNetValue === undefined
      ? insufficient
      : { kind: 'text', text: `${formatDecimalFixed(latestNetValue, 4)} ${t('business.investments.units.netValue')}` } },
    { key: 'netValueDate', labelKey: 'business.investments.netValueDate', value: latestNetValueDate === undefined
      ? insufficient
      : { kind: 'text', text: formatBusinessDate(latestNetValueDate) } },
    { key: 'marketValue', labelKey: 'business.investments.marketValue', value: holding.marketValue === undefined
      ? insufficient
      : { kind: 'decimal', amount: holding.marketValue } },
    { key: 'remainingCost', labelKey: 'business.investments.remainingCost',
      value: { kind: 'money', amount: holding.amount } },
    { key: 'holdingProfit', labelKey: 'business.investments.holdingProfit', value: holding.profit === undefined
      ? insufficient
      : { kind: 'decimal', amount: holding.profit, signed: true } },
    // `profitRate` is SIGNED: a losing holding reports a negative ratio, so it must not pass through
    // the nonnegative gate (that threw during render and blanked the page).
    { key: 'holdingProfitRate', labelKey: 'business.investments.holdingProfitRate', value: profitRate === undefined
      ? insufficient
      : { kind: 'text', text: `${signedRateToPercent(profitRate)}%` } },
    { key: 'cumulativeProfit', labelKey: 'business.investments.cumulativeProfit', value: holding.cumulativeProfit === undefined
      ? insufficient
      : { kind: 'decimal', amount: holding.cumulativeProfit, signed: true } },
    { key: 'realizedProfit', labelKey: 'business.investments.realizedProfit', value: holding.realizedProfit === undefined
      ? insufficient
      : { kind: 'decimal', amount: holding.realizedProfit } },
  ];
}

/** Renders one fact value through the shared money components (exact text, presentation only). */
function FactValue({ value }: { value: FactValue }) {
  if (value.kind === 'money') return <Money amount={value.amount} />;
  if (value.kind === 'decimal') return <DecimalMoney amount={value.amount} signed={value.signed} />;
  return <>{value.text}</>;
}

export function HoldingFacts({ holding, layout }: { holding: HoldingView; layout: HoldingFactsLayout }) {
  const { t } = useI18n();
  return <>{buildFacts(holding, t).map(fact => layout === 'tile' ? (
    <div key={fact.key} className="flex items-center justify-between gap-3 text-sm">
      <span className="text-banking-navy/60">{t(fact.labelKey)}</span>
      <span className="font-medium text-banking-deep"><FactValue value={fact.value} /></span>
    </div>
  ) : (
    <div key={fact.key} className="flex flex-wrap justify-between gap-2">
      <dt className="text-banking-navy/60">{t(fact.labelKey)}</dt>
      <dd className="font-medium text-banking-deep"><FactValue value={fact.value} /></dd>
    </div>
  ))}</>;
}
