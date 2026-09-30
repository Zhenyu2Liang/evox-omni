/**
 * tests/helpers — barrel re-exporting the shared test utilities.
 *
 * Specs may `import { ... } from '../helpers'` (or a specific module). See `./CONTEXT.md`
 * for the full helper API and usage rules.
 */
export * as db from './db';
export * as fixtures from './fixtures';
export * as fauxAgent from './faux-agent';
export * as scenario from './scenario';

export * from './fixtures';
export {
  buildFauxAgent,
  fauxRegistrationOf,
  text,
  tool,
  final,
  callThen,
  type FauxStep,
  type FauxToolCall,
  type FauxAgentOptions,
} from './faux-agent';
export {
  runTurn,
  confirmAction,
  verifyAction,
  cancelAction,
  newSessionId,
  collectEvents,
  toolEventsOf,
  cardsOfType,
  type ScenarioResult,
  type RunTurnInput,
} from './scenario';
export {
  getTestPrisma,
  truncateAll,
  resetDatabase,
  useFreshDatabase,
  disconnectTestPrisma,
} from './db';
