import { parseBankingGuidance } from './banking-guidance';

export type ReplyFormatIssue = 'guidance_format' | 'reasoning_format' | 'assistant_envelope' | 'tool_envelope';
export interface ReplyFormatPolicy { allowProtocolExamples?: boolean }

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function content(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value) && value.every(part => object(part) && (
    part.type === 'text' && typeof part.text === 'string' ||
    part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string' && object(part.arguments)
  ));
}

/** Recognize complete protocol envelopes only; ordinary wording never determines reply validity. */
export function inspectReplyFormat(prose: string, policy: ReplyFormatPolicy = {}): ReplyFormatIssue[] {
  const text = prose.trim();
  if (!text || policy.allowProtocolExamples) return [];
  for (const tag of ['think', 'thinking', 'analysis', 'reasoning']) {
    const opening = `<${tag}>`;
    const closing = `</${tag}>`;
    if (text.startsWith(opening) && text.indexOf(closing, opening.length) === text.length - closing.length) {
      return ['reasoning_format'];
    }
  }
  // A whole JSON fence is an envelope candidate; examples embedded in prose are ordinary Markdown.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  let value: unknown;
  try { value = JSON.parse(fenced?.[1] ?? text); } catch { return []; }
  if (!object(value)) return [];
  if (Object.keys(value).length === 1 && Object.hasOwn(value, 'guidance')) {
    return parseBankingGuidance(text) ? [] : ['guidance_format'];
  }
  if (typeof value.reasoning_content === 'string' && typeof value.answer === 'string' &&
      Object.keys(value).every(key => key === 'reasoning_content' || key === 'answer')) return ['reasoning_format'];
  if (typeof value.thinking === 'string' && Object.keys(value).length === 1) return ['reasoning_format'];
  if (value.role === 'assistant' && content(value.content) || value.type === 'assistant' && typeof value.text === 'string' ||
      Object.keys(value).length === 1 && object(value.assistant) && content(value.assistant.content) ||
      content(value.content) && typeof value.stopReason === 'string' &&
      typeof value.api === 'string' && typeof value.provider === 'string' && typeof value.model === 'string' && object(value.usage)) {
    return ['assistant_envelope'];
  }
  if ((value.role === 'tool' || value.role === 'toolResult') && content(value.content) ||
      typeof value.toolCallId === 'string' && typeof value.toolName === 'string' && content(value.content) ||
      Array.isArray(value.tool_calls) && value.tool_calls.length > 0 && value.tool_calls.every(call => object(call) &&
        typeof call.id === 'string' && call.type === 'function' && object(call.function) &&
        typeof call.function.name === 'string' && typeof call.function.arguments === 'string')) {
    return ['tool_envelope'];
  }
  return [];
}
