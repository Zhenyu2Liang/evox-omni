import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentRunJournal } from '../durable/journal';

/** Fragmented arguments cannot be reliably credential-redacted until Pi assembles the tool call. */
function providerEvidence(event: unknown): unknown {
  if (!event || typeof event !== 'object' || !('choices' in event) || !Array.isArray(event.choices)) return event;
  return { ...event, choices: event.choices.map(choice => {
    if (!choice?.delta || !Array.isArray(choice.delta.tool_calls)) return choice;
    return { ...choice, delta: { ...choice.delta, tool_calls: choice.delta.tool_calls.map((call: { function?: { arguments?: unknown } }) =>
      call.function && typeof call.function.arguments === 'string' ? { ...call,
        function: { ...call.function, arguments: '[REDACTED TOOL ARGUMENT FRAGMENT]', argumentBytes: Buffer.byteLength(call.function.arguments) } } : call) } };
  }) };
}

/** Persist provider evidence before Pi can admit a result or execute a proposed tool. */
export function withModelAudit(stream: StreamFn, journal: AgentRunJournal): StreamFn {
  return (model, context, options) => stream(model, context, {
    ...options,
    onPayload: async (payload, currentModel) => {
      const replacement = await options?.onPayload?.(payload, currentModel);
      await journal.recordModelProviderEvent('provider_request_payload', replacement === undefined ? payload : replacement);
      return replacement;
    },
    onResponse: async (response, currentModel) => {
      const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) =>
        ['content-type', 'x-request-id', 'request-id'].includes(name.toLowerCase())));
      await journal.recordModelProviderEvent('provider_response_headers', { status: response.status, headers });
      await options?.onResponse?.(response, currentModel);
    },
    onProviderStreamEvent: async (event, currentModel) => {
      await journal.recordModelProviderEvent('provider_response_event', providerEvidence(event));
      await options?.onProviderStreamEvent?.(event, currentModel);
    },
  });
}
