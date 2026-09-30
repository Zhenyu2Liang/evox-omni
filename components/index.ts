/**
 * components — root barrel facade for the AI Banking Agent UI library.
 *
 * Neutral (non-`'use client'`) module: it re-exports both Client components
 * (`./chat`, `./charts`) and Server-safe presentational components (`./ui`,
 * `./banking`, `./security`). Consumers pick the subset they need.
 */
export * from './ui';
export * from './chat';
export * from './chat/cards';
export * from './charts';
export * from './banking';
export * from './security';
