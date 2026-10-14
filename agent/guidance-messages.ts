import messages from './messages/conversation.zh-CN.json';

export type ConversationGuidanceCode = Exclude<keyof typeof messages, 'unverified' | 'unavailable'>;

/** A closed presentation vocabulary contains no request interpretation or tool permissions. */
export function isConversationGuidanceCode(value: string): value is ConversationGuidanceCode {
  return Object.hasOwn(messages, value) && value !== 'unverified' && value !== 'unavailable';
}

export function renderConversationGuidance(code: ConversationGuidanceCode): string {
  return messages[code];
}
