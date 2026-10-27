import type { ChatMessage } from '@/lib/contracts/agent';
import { formatBusinessDate } from '@/lib/date';

/** Match the message renderer: an empty, suppressed authorization is not a date boundary. */
export function isVisibleChatMessage(message: ChatMessage): boolean {
  return message.content.length > 0 || (message.role === 'tool' || message.role === 'system') &&
    ((message.cards?.length ?? 0) > 0 || (message.toolEvents?.length ?? 0) > 0);
}

/** Absolute dates use the stored message timestamp in UTC+08:00 without re-dating history. */
export function messageDay(timestamp: number): string | undefined {
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8_640_000_000_000_000 ? formatBusinessDate(timestamp) : undefined;
}

export function MessageDayDivider({ day }: { day: string }) {
  return <div data-chat-day={day} className="flex items-center gap-3 py-1">
    <span aria-hidden="true" className="h-px flex-1 bg-slate-200/70" />
    <time dateTime={day} className="shrink-0 rounded-full bg-white/80 px-3 py-1 text-[11px] font-medium tabular-nums text-banking-navy">{day}</time>
    <span aria-hidden="true" className="h-px flex-1 bg-slate-200/70" />
  </div>;
}
