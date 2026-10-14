import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { parseAmount } from './amount-parser';
import { contentToText } from './conversation';
import { plain, toolCall } from './replies';
import { isConversationalRequest } from './conversation-policy';

interface TransferIntent {
  recipient?: string;
  amount?: string;
  remark?: string;
  reuseRecipient: boolean;
  explicitReuse: boolean;
}
interface ContactMatch { id?: string; name: string }

export function isTransferIntent(text: string): boolean {
  return /(转账|转帐|汇款|打钱|转钱|转给|转笔|再转)/.test(text) ||
    /(给|向|帮).{0,10}(转|打|汇)/.test(text) || /转\s*[\d零一二三四五六七八九十百千万两]/.test(text);
}

export function parseTransfer(text: string): TransferIntent {
  const remarkMatch = text.match(/备注[:：]?\s*(.+)$/);
  const remark = remarkMatch?.[1]?.trim() || undefined;
  const withoutRemark = remarkMatch ? text.slice(0, remarkMatch.index) : text;
  const amount = parseAmount(withoutRemark);
  const rawRecipient = extractRecipient(withoutRemark);
  const reuseRecipient = !rawRecipient || /(刚才|那个|那位|那个人|他|她|此人|同上|之前的|上次的|同一个)/.test(rawRecipient);
  return {
    recipient: reuseRecipient ? undefined : rawRecipient, amount, remark, reuseRecipient,
    explicitReuse: /(刚才|那个|那位|那个人|他|她|同上|之前|上次|同一个|再转|还是)/.test(text),
  };
}

/** First resolve a recipient; never infer a contact identity from a model-authored name. */
export function handleTransfer(text: string, messages: Message[]): AssistantMessage {
  const intent = parseTransfer(text);
  if (intent.reuseRecipient) {
    const prior = intent.explicitReuse ? priorTransferRecipient(messages) : null;
    if (!prior) return plain(intent.explicitReuse
      ? '我还没有记录到之前的收款人，请告诉我这次要转给谁、转多少钱。'
      : '请问要转给谁？请告诉我收款人和金额，例如“给张伟转200元”。');
    const label = prior.name ?? prior.contactId ?? '对方';
    if (intent.amount == null) return plain(`请问要转给${label}多少钱？`);
    const args: Record<string, unknown> = { ...prior, amount: intent.amount };
    if (intent.remark) args.remark = intent.remark;
    return toolCall('transfer_money', args);
  }
  if (!intent.recipient) return plain('请问要转给谁？请告诉我收款人和金额，例如“给张伟转200元”。');
  if (intent.amount == null) return plain(`请问要给${intent.recipient}转多少钱？`);
  return toolCall('search_contact', { query: intent.recipient });
}

export function refineTransfer(text: string, result: ToolResultMessage): AssistantMessage {
  const intent = parseTransfer(text);
  const contacts = parseContacts(result);
  if (contacts.length === 0) return plain(`没有找到“${intent.recipient ?? '该联系人'}”这位联系人，请确认姓名后再说一次。`);
  if (contacts.length > 1) {
    return plain(`我找到 ${contacts.length} 位匹配的联系人：${contacts.map(contact => contact.name).join('、')}。请确认要转给哪一位？`);
  }
  const one = contacts[0];
  if (intent.amount == null) return plain(`请问要给${one.name}转多少钱？`);
  const args: Record<string, unknown> = one.id ? { contactId: one.id } : { name: one.name };
  args.amount = intent.amount;
  if (intent.remark) args.remark = intent.remark;
  return toolCall('transfer_money', args);
}

function extractRecipient(text: string): string | undefined {
  const patterns = [
    /(?:转给|转账给|转帐给|给|向|帮)\s*([\u4e00-\u9fa5A-Za-z·]{1,20}?)(?:转|汇|打|转账)/,
    /(?:转给|转账给|转帐给)\s*([\u4e00-\u9fa5A-Za-z·]{1,20})/,
    /(?:给|向)\s*([\u4e00-\u9fa5A-Za-z·]{1,20})/,
  ];
  for (const pattern of patterns) {
    const candidate = text.match(pattern)?.[1]?.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

export function priorTransferRecipient(messages: Message[]): { contactId?: string; name?: string } | null {
  let boundary = -1;
  let latestUserSkipped = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (!latestUserSkipped) { latestUserSkipped = true; continue; }
    if (isConversationalRequest(contentToText(message.content))) { boundary = index; break; }
  }
  for (let index = messages.length - 1; index > boundary; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = message.content[blockIndex];
      if (block.type !== 'toolCall' || block.name !== 'transfer_money') continue;
      const args = (block.arguments ?? {}) as Record<string, unknown>;
      const contactId = typeof args.contactId === 'string' ? args.contactId : undefined;
      const name = typeof args.name === 'string' ? args.name : undefined;
      if (contactId || name) return { contactId, name };
    }
  }
  for (let index = messages.length - 1; index > boundary; index--) {
    const message = messages[index];
    if (message.role === 'toolResult' && message.toolName === 'search_contact') {
      const contacts = parseContacts(message);
      if (contacts.length === 1) return { contactId: contacts[0].id, name: contacts[0].name };
    }
  }
  return null;
}

function parseContacts(result: ToolResultMessage): ContactMatch[] {
  const details = result.details;
  if (Array.isArray(details)) {
    const contacts: ContactMatch[] = [];
    for (const item of details) {
      if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        const contact = item as { id?: unknown; name: string };
        contacts.push({ id: typeof contact.id === 'string' ? contact.id : undefined, name: contact.name });
      }
    }
    if (contacts.length > 0 || details.length === 0) return contacts;
  }
  const text = contentToText(result.content);
  if (/未找到/.test(text)) return [];
  const countMatch = text.match(/找到\s*(\d+)\s*位/);
  if (!countMatch) return [];
  const count = Number(countMatch[1]);
  if (!Number.isFinite(count) || count <= 0) return [];
  const colon = text.indexOf('：');
  return (colon >= 0 ? text.slice(colon + 1) : text).split(/[、，,]/)
    .map(segment => segment.trim()).filter(segment => segment !== '' && !segment.startsWith('另有'))
    .map(segment => segment.replace(/[（(].*$/, '').trim()).filter(name => name !== '').map(name => ({ name }));
}
