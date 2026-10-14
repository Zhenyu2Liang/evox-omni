import messages from './messages/dialogue.zh-CN.json';

/** Prose is preserved verbatim; authorization and financial evidence belong to tool records. */
export function renderConversationalResponse(prose: string): string {
  return prose.trim() ? prose : messages.emptyReply;
}

export const CONVERSATION_GENERATION_FAILED = messages.generationFailed;
