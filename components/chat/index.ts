/**
 * components/chat — neutral re-export barrel for the chat surface.
 *
 * This module is deliberately NOT a Client Component (`'use client'`): it only
 * re-exports the chat surface, and every leaf file (ChatWindow, MessageBubble,
 * Composer, ToolEventList, StreamingText, useAgentStream, actions) already carries
 * its own `'use client'` directive. Keeping the intermediate barrel neutral lets it
 * be star-re-exported through the neutral `components/index.ts` facade so the RSC
 * layer resolves a real client reference at SSR (a `'use client'` intermediate barrel
 * star-re-exported through the facade resolves to `undefined` and breaks SSR).
 */
export * from './ChatWindow';
export * from './MessageBubble';
export * from './Composer';
export * from './ToolEventList';
export * from './StreamingText';
export * from './useAgentStream';
export * from './actions';
export type { TaskControlAction, AttentionClass, OutOfBandAttention } from './cards';
