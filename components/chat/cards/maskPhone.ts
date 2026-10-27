/**
 * Display masking lives in `lib/mask.ts` (zero-dependency, single implementation for every layer);
 * re-exported so the existing `./maskPhone` imports and the `chat/cards` barrel keep working.
 */
export { maskPhone } from '@/lib/mask';
