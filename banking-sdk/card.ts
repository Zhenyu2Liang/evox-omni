/**
 * Banking SDK — card reads & mutations.
 * `getCards` is GREEN; the mutations are executed only after the Security Gateway's tier policy
 * (YELLOW/RED) is satisfied — this module performs no permission checks itself.
 */
import type {
  ApplyVirtualCardInput,
  CardView,
  ReportLostCardInput,
  SetCardLimitInput,
} from './types';

/** All cards owned by the user (with per-category limits). */
export async function getCards(userId: string): Promise<CardView[]> {
  throw new Error('not implemented');
}

/** Set/replace the per-category spend limit on a card; returns the updated card. */
export async function setCardLimit(input: SetCardLimitInput): Promise<CardView> {
  throw new Error('not implemented');
}

/** Freeze a card (status → FROZEN); returns the updated card. */
export async function freezeCard(cardId: string): Promise<CardView> {
  throw new Error('not implemented');
}

/** Unfreeze a card (status → ACTIVE); returns the updated card. */
export async function unfreezeCard(cardId: string): Promise<CardView> {
  throw new Error('not implemented');
}

/** Report a card lost (status → LOST); returns the updated card. */
export async function reportLostCard(
  cardId: string,
  input: ReportLostCardInput = {},
): Promise<CardView> {
  throw new Error('not implemented');
}

/** Issue a new virtual card; returns the created card. */
export async function applyVirtualCard(input: ApplyVirtualCardInput): Promise<CardView> {
  throw new Error('not implemented');
}
