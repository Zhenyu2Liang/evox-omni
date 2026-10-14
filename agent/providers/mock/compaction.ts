import { contentText, fauxAssistantMessage, getSystemMessageText, type AssistantMessage, type Context } from '@earendil-works/pi-ai';

/** Offline summary generation is purpose-specific and cannot propose a bank tool. */
export function mockCompactionReply(context: Context, maxTokens = 2048): AssistantMessage | undefined {
  const system = context.messages.filter(message => message.role === 'system').map(getSystemMessageText).join('\n');
  if (!system.startsWith('You are a context summarization assistant.')) return;
  const user = context.messages.findLast(message => message.role === 'user');
  const prompt = user && user.role === 'user' ? contentText(user.content) : '';
  const conversation = /^<conversation>\n([\s\S]*)\n<\/conversation>/.exec(prompt)?.[1] ?? '';
  const previousText = /\n<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/.exec(prompt)?.[1] ?? '';
  let previous: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(previousText || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) previous = value as Record<string, unknown>;
  } catch { /* A prior live summary remains untrusted text. */ }
  const previousStrings = (key: string): string[] => Array.isArray(previous[key])
    ? previous[key].filter((value: unknown): value is string => typeof value === 'string') : [];
  // Parse Pi's serialized user sections only. Assistant prose and tool output are not user quotes.
  const quotes = [...conversation.matchAll(/(?:^|\n\n)\[User\]: ([\s\S]*?)(?=\n\n\[(?:User|Assistant(?: thinking| tool calls)?|Tool result)\]: |$)/g)]
    .map(match => match[1]);
  const source = `${previousText}\n${quotes.join('\n')}`;
  const memory = {
    signedReferences: [...new Set([...previousStrings('signedReferences'), ...[...source.matchAll(/[\-−－]\s*\d+(?:\.\d+)?(?:\s*(?:\u5143|CNY|yuan))?/gi)].map(match => match[0])])].slice(-8),
    userPreferences: [...new Set([...previousStrings('userPreferences'), ...quotes.filter(text =>
      /(?:\u559c\u6b22|\u504f\u597d|\u5e0c\u671b|\u8bb0\u4f4f|\u4e0d\u8981)|\b(?:prefer|preference|remember|don't)\b/i.test(text))])].slice(-4),
    recentUserQuotes: [...previousStrings('recentUserQuotes'), ...quotes].slice(-3),
    archiveLookupRequired: true,
    notAuthorization: true,
  };
  // The summary is intentionally bounded; original wording is still available through archive search.
  while (JSON.stringify(memory).length > Math.max(128, maxTokens) &&
      (memory.recentUserQuotes.length || memory.userPreferences.length || memory.signedReferences.length > 1)) {
    if (memory.recentUserQuotes.length) memory.recentUserQuotes.shift();
    else if (memory.userPreferences.length) memory.userPreferences.shift();
    else memory.signedReferences.shift();
  }
  return fauxAssistantMessage(JSON.stringify(memory));
}
