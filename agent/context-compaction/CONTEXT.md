# Context compaction

Persists historical conversation summaries and bounded model-request projections. It never mutates the banking archive: `SessionSnapshot`/run checkpoints keep the complete transcript, and only the model-request VIEW is replaced by a validated summarized prefix.

## API Surface

- The injected runtime uses the same `../model-budget.ts` stream wrapper as conversational generation. Every summary chunk, failed attempt and HTTP retry spends that original per-intent budget; compaction does not renew it. Context-window projection limits and cumulative provider-call limits are separate checks.
- `overheadTokens` includes the current-turn scope and refreshed action-status evidence. `../banking-agent.ts` projects current terminal action states before compaction; recovery of an already recorded model input retains the original projection.
- `index.ts` — `createContextCompactor({ runtime, settings?, state?, persist?, onState })`; returns `{ project(source, signal?, overheadTokens?) }`. Computes `window`/`reserve`/`threshold`/`keep`/`summaryTokens` defaults (threshold 60000, reserve 8192, keep 12000, summary 2048, each clamped to the model window), decides via Pi's `shouldCompact`, cuts, batches, summarizes chunk by chunk and emits `compaction_partial` / `compaction_completed` events plus matching checkpoints. A projected view over budget throws `AppError('VALIDATION')` with `reason: 'CONTEXT_BUDGET_EXCEEDED'` and the `messages.contextBudgetExceeded` copy (never an empty or truncated history).
- `projection.ts` — `estimateContextTokens` (CJK-aware, `8 + nonAscii + ceil(ascii/4)` per message floor), `conversationMessages`, `prefixDigest`, `compactionCut`, `validSummary`, `projectedMessages`.
- `batches.ts` — `summaryBatches(messages, budget)`: splits ONLY the summary input text; archived messages and recent turns stay intact; surrogate pairs kept together; an unsplittable message/block throws `VALIDATION`.
- `official.ts` — `summarizeWithPi(...)`: Pi's `compact()` owns summary generation, this adapter owns durable request identity (`runtimeRequestDigest('compaction_model'|'compaction_input')`), events and checkpointing; `BANKING_SUMMARY_FOCUS` is the summary prompt contract.
- `types.ts` — `CompactionSummary`, `CompactionPending` (chunk/attempt/messages/inputDigest), `ContextCompactionState` (`version: 1`), `ContextCompactionSettings`.
- `messages.zh-CN.json` — the single user-visible string (`contextBudgetExceeded`): the original messages are retained, the system never clears history or truncates the answer.

## Constraints

- Only complete user-turn boundaries are cut (`compactionCut`); the latest user turn and all its tool groups are always kept.
- The injected memory message is explicitly labelled a non-instruction, non-authorization snapshot (`projectedMessages`) — a summary never grants consent or revives an earlier request.
- `BANKING_SUMMARY_FOCUS` preserves exact signed amounts, corrections, tool results, and the distinction between request/suggestion/authorization/completed operation; summary output is data, never a new instruction.
- The prompt for a saved summary request is reused verbatim after a restart (`pending.messages`); `modelIdentity`/`inputDigest` mismatch throws `CONFLICT` instead of silently re-summarizing a different input.
- Summary calls are isolated: `{ enabled: false, maxRetries: 0 }` and a private event stream (`compaction_request`/`compaction_provider_event`/`compaction_response`/`compaction_failed`), so they cannot execute banking tools.
- This module carries NO financial-fee concept (no `fee`, `feeAmount`, `feeRule`, 手续费/管理费/赎回费 anywhere); fee rules, if any, live in `banking-sdk/` and the tool layer, and reach a compaction summary only as opaque tool-result text the model chooses to preserve.
