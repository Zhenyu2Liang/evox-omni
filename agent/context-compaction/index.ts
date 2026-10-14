import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { shouldCompact } from '@earendil-works/pi-coding-agent';
import type { ModelRuntime } from '../providers/types';
import type { ContextCompactionSettings, ContextCompactionState, CompactionPending } from './types';
import { compactionCut, conversationMessages, estimateContextTokens, prefixDigest, projectedMessages, validSummary } from './projection';
import { runtimeRequestDigest } from '../durable/serialization';
import { AppError } from '@/lib/errors';
import messages from './messages.zh-CN.json';
import { summaryBatches } from './batches';
import { summarizeWithPi } from './official';

export type { ContextCompactionState, ContextCompactionSettings } from './types';

export interface CompactionPersistence {
  event(type: string, payload: unknown): Promise<void>;
  checkpoint(stage: string): Promise<void>;
}

/** Use Pi request projection hooks; the banking archive is never sliced or rewritten. */
export function createContextCompactor(options: {
  runtime: ModelRuntime;
  settings?: ContextCompactionSettings;
  state?: ContextCompactionState;
  persist?: CompactionPersistence;
  onState(state: ContextCompactionState): void;
}) {
  let state: ContextCompactionState = options.state ?? { version: 1 };
  const window = Math.max(1024, options.runtime.model.contextWindow);
  const reserve = Math.min(options.settings?.reserveTokens ?? 8192, Math.floor(window / 4));
  const threshold = Math.min(options.settings?.thresholdTokens ?? 60000, window - reserve);
  const keep = Math.min(options.settings?.keepRecentTokens ?? 12000, Math.floor(threshold / 2));
  const summaryTokens = Math.min(options.settings?.summaryTokens ?? 2048, Math.max(128, Math.floor(threshold / 8)));
  const modelIdentity = runtimeRequestDigest('compaction_model', options.runtime.model);
  const update = (next: ContextCompactionState) => { state = next; options.onState(next); };
  const event = (type: string, payload: unknown) => options.persist?.event(type, payload) ?? Promise.resolve();
  const checkpoint = (stage: string) => options.persist?.checkpoint(stage) ?? Promise.resolve();

  return {
    async project(source: readonly AgentMessage[], signal?: AbortSignal, overheadTokens = 0): Promise<AgentMessage[]> {
      const conversation = conversationMessages(source);
      const summary = validSummary(conversation, state.summary) ? state.summary : undefined;
      const current = projectedMessages(source, summary);
      const budget = window - reserve;
      const assertFits = (view: AgentMessage[]) => {
        if (estimateContextTokens(view) + overheadTokens > budget) throw new AppError('VALIDATION', messages.contextBudgetExceeded,
          { reason: 'CONTEXT_BUDGET_EXCEEDED', tokens: estimateContextTokens(view) + overheadTokens, budget });
        return view;
      };
      const tokensBefore = estimateContextTokens(current) + overheadTokens;
      if (!shouldCompact(tokensBefore, window, { enabled: true, reserveTokens: window - threshold, keepRecentTokens: keep }) && !state.pending) return assertFits(current);
      const cut = compactionCut(conversation, keep);
      if (cut === 0 || cut <= (summary?.coveredMessages ?? 0)) return assertFits(current);
      const digest = prefixDigest(conversation, cut);
      let pending = state.pending;
      if (!pending || pending.coveredMessages !== cut || pending.prefixDigest !== digest) {
        const history = conversation.slice(summary?.coveredMessages ?? 0, cut);
        // Leave room for Pi's instructions, the preceding summary, and model output.
        const chunks = summaryBatches(history, Math.max(64, window - reserve - 2 * summaryTokens - 2048));
        pending = { id: randomUUID(), coveredMessages: cut, prefixDigest: digest,
          inputDigest: runtimeRequestDigest('compaction_input', []), modelIdentity, messages: [], attempt: 0,
          chunks, chunkIndex: 0, maxTokens: summaryTokens, previousSummary: summary?.text, tokensBefore };
      }
      let text: string;
      while (true) {
        text = await summarizeWithPi({ runtime: options.runtime, pending, signal, event, checkpoint,
          save: next => { pending = next; update({ ...state, pending: next }); } });
        if (pending.chunkIndex === pending.chunks.length - 1) break;
        pending = { ...pending, chunkIndex: pending.chunkIndex + 1, messages: [], previousSummary: text,
          inputDigest: runtimeRequestDigest('compaction_input', []), attempt: 0 };
        update({ ...state, pending });
        await event('compaction_partial', { id: pending.id, chunkIndex: pending.chunkIndex, summary: text });
        await checkpoint('compaction_partial');
      }
      const next = { coveredMessages: cut, prefixDigest: digest, text,
        tokensBefore: estimateContextTokens(current) + overheadTokens, tokensAfter: 0 };
      next.tokensAfter = estimateContextTokens(projectedMessages(source, next)) + overheadTokens;
      update({ ...state, pending: undefined, summary: next });
      await event('compaction_completed', { id: pending.id, ...next });
      await checkpoint('compaction_completed');
      return assertFits(projectedMessages(source, next));
    },
  };
}
