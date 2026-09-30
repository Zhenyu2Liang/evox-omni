'use client';

/**
 * `ToolEventList.tsx` — task/tool status timeline (NO chain-of-thought).
 *
 * DESIGN-STUB phase: renders nothing; the real timeline lands in the implementation phase.
 */
import type { ToolEventView } from '@/lib/contracts/agent';

export interface ToolEventListProps {
  events: ToolEventView[];
  className?: string;
}

export function ToolEventList(p: ToolEventListProps) {
  return null;
}
