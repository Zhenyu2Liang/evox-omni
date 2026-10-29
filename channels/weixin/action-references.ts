import type { WeixinState } from './state';

/** A display alias only: every banking request still uses its original exact action ID. */
export function offerActionReference(state: WeixinState, id: string): string {
  const offered = state.offered[id] ??= { confirmed: false };
  if (offered.shortId === undefined) {
    let candidate = state.nextActionNumber;
    for (const existing of Object.values(state.offered)) candidate = Math.max(candidate, (existing.shortId ?? 0) + 1);
    while (Object.hasOwn(state.offered, String(candidate))) candidate++;
    if (!Number.isSafeInteger(candidate + 1)) throw new Error('微信操作短编号已用尽，请在网页处理。');
    offered.shortId = candidate;
    state.nextActionNumber = candidate + 1;
  }
  return String(offered.shortId);
}

export function actionReference(state: WeixinState, id: string): string {
  return state.offered[id]?.shortId?.toString() ?? id;
}

/** No prefixes, last-action guesses or recycled list indices are accepted. */
export function resolveActionReference(state: WeixinState, reference: string): string | undefined {
  const candidates = new Set<string>();
  if (Object.hasOwn(state.offered, reference)) candidates.add(reference);
  for (const [id, offered] of Object.entries(state.offered)) if (offered.shortId?.toString() === reference) candidates.add(id);
  return candidates.size === 1 ? [...candidates][0] : undefined;
}
