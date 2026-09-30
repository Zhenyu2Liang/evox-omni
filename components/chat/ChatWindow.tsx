'use client';

/**
 * `ChatWindow.tsx` — the container: message list + composer; owns `useAgentStream`.
 *
 * The browser NEVER executes a banking operation directly: the confirm/verify/cancel callbacks
 * only invoke the hook, which POSTs to the `./app` action routes where the server re-validates
 * and executes. No chain-of-thought is rendered here — only messages, cards, tool status.
 */
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { ChatEndpoints } from './actions';
import type { CardActionHandlers } from './cards';
import { useAgentStream } from './useAgentStream';
import { MessageBubble } from './MessageBubble';
import { StreamingText } from './StreamingText';
import { ToolEventList } from './ToolEventList';
import { Composer } from './Composer';
import { EmptyState } from '../ui';

export interface ChatWindowProps {
  sessionId?: string;
  initialMessages?: ChatMessage[];
  endpoints?: ChatEndpoints;
  className?: string;
}

export function ChatWindow({ sessionId, initialMessages, endpoints, className }: ChatWindowProps) {
  const stream = useAgentStream({ sessionId, initialMessages, endpoints });
  const listRef = useRef<HTMLDivElement>(null);

  const lastMessageId =
    stream.messages.length > 0 ? stream.messages[stream.messages.length - 1].id : undefined;

  // Auto-scroll the list to the bottom as new content arrives.
  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastMessageId, stream.streamingText]);

  const action: CardActionHandlers = {
    actionId: stream.pendingAction?.actionId,
    onConfirm: (id) => void stream.confirm(id),
    onVerify: (id, code) => void stream.verify(id, code),
    onCancel: (id) => void stream.cancel(id),
    onAcknowledge: () => void stream.send('这笔交易是我本人消费'),
    onViewDetail: () => void stream.send('我想查看这笔交易的详情'),
    onFreeze: () => void stream.send('冻结我的银行卡'),
    busy: stream.busy,
    error: stream.error,
  };

  return (
    <div className={`flex h-full min-h-0 flex-col bg-banking-light ${className ?? ''}`.trim()}>
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {stream.messages.length === 0 ? (
          <EmptyState
            title="开始与 AI 银行助手对话"
            description="用自然语言描述你的需求，例如「查一下我的余额」或「给张伟转账 200 元」。"
          />
        ) : (
          <>
            {stream.messages.map((m) => (
              <MessageBubble key={m.id} message={m} action={action} />
            ))}
            {stream.streamingText.length > 0 && (
              <StreamingText text={stream.streamingText} active={stream.busy} />
            )}
          </>
        )}
      </div>

      {stream.toolEvents.length > 0 && (
        <div className="border-t border-banking-light bg-white/70 px-4 py-3">
          <ToolEventList events={stream.toolEvents} />
        </div>
      )}

      <div className="border-t border-banking-light bg-white p-3">
        <Composer onSend={stream.send} busy={stream.busy} disabled={stream.busy} />
      </div>
    </div>
  );
}
