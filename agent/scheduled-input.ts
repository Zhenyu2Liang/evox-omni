import type { ConversationIntent } from '@/lib/contracts/intent';

export const SCHEDULE_TIME_QUESTION = '请问具体几点执行？（北京时间）';

/** A correction asking for the missing clock must not retain an earlier invented schedule preview. */
export function asksForExecutionTime(prose: string): boolean {
  return /几点[^。！？!?\n]*[？?]|(?:执行|转账|付款|提醒)[^。！？!?\n]{0,16}(?:具体时间|具体时刻)[^。！？!?\n]*[？?]|what time[^.!?\n]*\?/i.test(prose);
}

/** Presence check only: never derive a command time, recipient or authorization from prose. */
export function hasExplicitTimeChoice(text: string): boolean {
  const clock = /(?<!\d)(?:[01]?\d|2[0-3])[:：][0-5]\d(?!\d)|(?<![\d零〇一二两三四五六七八九十])(?:[01]?\d|2[0-3]|二十[一二三]?|十[一二三四五六七八九]?|[零〇一二两三四五六七八九])\s*(?:点|時|时)(?!间)|(?<!\d)(?:0?[1-9]|1[0-2])\s*(?:a\.?m\.?|p\.?m\.?)\b|\bat\s+(?:[01]?\d|2[0-3])\b|(?:\d+|[一二两三四五六七八九十]+)\s*(?:分钟|小时|秒钟?)后|\bin\s+\d+\s+(?:minutes?|hours?|seconds?)\b/gi;
  return [...text.matchAll(clock)].some(match => {
    // A rejected or quoted example time is not the customer's selected execution time.
    const prefix = text.slice(Math.max(0, match.index! - 16), match.index);
    return !/(?:不要(?:默认)?|不能(?:默认)?|不是|别(?:默认)?|例如|比如|\bnot|\bexample:?|\be\.g\.)\s*$/i.test(prefix);
  });
}

/** Current customer wording alone can satisfy the missing-time prerequisite; history cannot. */
export function guardScheduledTimeChoice(intent: ConversationIntent): ConversationIntent {
  if (intent.purpose !== 'operation' || !intent.steps.some(step => step.tool === 'create_scheduled_task') ||
      hasExplicitTimeChoice(intent.latestMessage) || intent.requiredInput === 'scheduled_time' && intent.needsInput) return intent;
  return { ...intent, needsInput: true, requiredInput: 'scheduled_time' };
}
