import { Type } from '@earendil-works/pi-ai';

/** Booked CNY inputs are exact decimal strings with at most two fractional digits. */
export const MoneyParameter = Type.String({
  pattern: '^\\d+(?:\\.\\d{1,2})?$',
  description: 'Exact CNY decimal text with at most two fractional digits.',
});
