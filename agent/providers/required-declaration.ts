import type { StreamFn } from '@earendil-works/pi-agent-core';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A corrective request can require interpretation, never a financial tool or authorization. */
export function withRequiredDeclaration(stream: StreamFn, required: () => boolean): StreamFn {
  return (model, context, options) => {
    if (!required() || model.provider !== 'deepseek' || model.api !== 'openai-completions') return stream(model, context, options);
    return stream(model, context, { ...options, onPayload: async (payload, currentModel) => {
      const replacement = await options?.onPayload?.(payload, currentModel);
      const current = replacement === undefined ? payload : replacement;
      // DeepSeek supports named tool choices only with thinking disabled. Preserve other modes.
      if (!record(current) || !record(current.thinking) || current.thinking.type !== 'disabled' ||
          !Array.isArray(current.tools) || !current.tools.some(tool => record(tool) && record(tool.function) && tool.function.name === 'describe_turn')) return replacement;
      return { ...current, tool_choice: { type: 'function', function: { name: 'describe_turn' } } };
    } });
  };
}
