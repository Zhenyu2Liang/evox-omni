import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import type { ConversationIntent } from '@/lib/contracts/intent';
import { declareConversationIntent } from '../intent-context';

export const TURN_INTENT_TOOL = 'describe_turn';
const parameters = Type.Object({
  purpose: Type.Union([Type.Literal('conversation'), Type.Literal('advice'), Type.Literal('query'), Type.Literal('operation')]),
  operations: Type.Array(Type.String(), { description: 'Banking capabilities for this turn, in order. During operation preparation, list only required reads until exact targets and counts are known. Then declare the complete write sequence once, preserving repeats. A declaration containing writes is final. Never include submit_plan.' }),
  allowProtocolExamples: Type.Optional(Type.Boolean({ description: 'True only when the user explicitly asks for protocol examples, source code or message envelopes.' })),
  workflow: Type.Optional(Type.Boolean({ description: 'True for conditional or ordered multi-operation requests which require one complete workflow.' })),
  needsInput: Type.Optional(Type.Boolean({ description: 'True when a required value or user choice is missing or ambiguous. For a complete operation explicitly set false. Once writes are declared this cannot change until a new user message. Missing defaults to true for operations.' })),
});

/** Internal control tool: it cannot access banking resources, grant consent, or move money. */
export function createTurnIntentTool(read: () => ConversationIntent, write: (intent: ConversationIntent) => void | Promise<void>): AgentTool<typeof parameters> {
  return { name: TURN_INTENT_TOOL, label: 'Understand request', parameters,
    executionMode: 'sequential',
    description: 'Declare how the current user message should be understood using the entire conversation. Purpose cannot change. GREEN lookups can precede declaration. Operation preparation may declare only required reads, then bind the complete write sequence after identifying exact targets; that write sequence cannot change. Advice is read-only. Capability questions and history are conversation. Missing details require clarification, not guessed values. This never authorizes a banking operation.',
    execute: async (_id, args) => {
      const intent = declareConversationIntent(read(), args.purpose, args.operations,
        { ...args, needsInput: args.needsInput ?? args.purpose === 'operation' });
      await write(intent);
      const declaration = { purpose: intent.purpose, operations: args.operations,
        workflow: Boolean(intent.workflow), needsInput: Boolean(intent.needsInput), allowProtocolExamples: Boolean(intent.allowProtocolExamples) };
      return { content: [{ type: 'text', text: JSON.stringify({ ...declaration, authorized: false }) }],
        details: { ...declaration, intentId: intent.id } };
    } };
}
