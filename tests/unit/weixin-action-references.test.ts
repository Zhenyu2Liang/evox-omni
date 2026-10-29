import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { emptyState, WeixinStore } from '@/channels/weixin/state';
import { offerActionReference, resolveActionReference } from '@/channels/weixin/action-references';
import { renderEvents } from '@/channels/weixin/banking-client';

describe('stable WeChat operation references', () => {
  it('loads legacy state without queue fields or counters and requires a fresh current-action preview', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'weixin-legacy-state-'));
    try {
      await writeFile(path.join(directory, 'state.json'), JSON.stringify({ version: 1, cursor: '', deliveries: {},
        offered: { old_action: { confirmed: true } }, plans: {} }));
      const loaded = await new WeixinStore(directory).load();
      expect(loaded.nextActionNumber).toBe(1);
      expect(loaded.confirmationQueue).toEqual([]);
      expect(loaded.activeActionId).toBeUndefined();
      expect(resolveActionReference(loaded, 'old_action')).toBe('old_action');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('binds independent short numbers to original IDs without accepting ID prefixes', () => {
    const state = emptyState();
    expect(offerActionReference(state, 'original_first')).toBe('1');
    expect(offerActionReference(state, 'original_second')).toBe('2');
    expect(offerActionReference(state, 'original_first')).toBe('1');
    expect(resolveActionReference(state, '1')).toBe('original_first');
    expect(resolveActionReference(state, '2')).toBe('original_second');
    expect(resolveActionReference(state, 'original_first')).toBe('original_first');
    for (const value of ['original', '01', '3', '']) expect(resolveActionReference(state, value)).toBeUndefined();
  });
  it('keeps reference bindings after reload and never reuses them after a recording reset', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'weixin-reference-'));
    try {
      const state = emptyState(); offerActionReference(state, 'old_action');
      await new WeixinStore(directory).save(state);
      const loaded = await new WeixinStore(directory).load();
      expect(resolveActionReference(loaded, '1')).toBe('old_action');
      const cleared = emptyState(loaded.nextActionNumber);
      expect(offerActionReference(cleared, 'new_action')).toBe('2');
      expect(resolveActionReference(cleared, '1')).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('migrates old offered entries without losing the full-ID route', () => {
    const state = emptyState(); state.offered.legacy_action = { confirmed: true };
    expect(resolveActionReference(state, 'legacy_action')).toBe('legacy_action');
    expect(offerActionReference(state, 'legacy_action')).toBe('1');
    expect(state.offered.legacy_action.confirmed).toBe(true);
  });
  it('does not register a reference for a gate that settles in the same event batch', () => {
    const state = emptyState();
    const result = renderEvents([
      { type: 'confirmation_required', actionId: 'settled', action: { title: '操作', toolName: 'transfer_money', tier: 'YELLOW', requiresMfa: false, fields: [] } },
      { type: 'action_settled', actionId: 'settled', status: 'executed' },
    ], { actionReference: id => offerActionReference(state, id) });
    expect(result.actionIds).toEqual([]);
    expect(state.offered).toEqual({}); expect(state.nextActionNumber).toBe(1);
  });
  it('fails closed if a damaged state maps one reference to multiple actions', () => {
    const state = emptyState();
    state.offered.first = { confirmed: false, shortId: 1 };
    state.offered.second = { confirmed: false, shortId: 1 };
    expect(resolveActionReference(state, '1')).toBeUndefined();
  });
});
