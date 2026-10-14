import type { ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import type { ToolExecutionResult } from '../tools';
import { toModelToolResult } from '../tools/result';

/** Full Pi results carry their original content; bank receipts carry data and a server summary. */
export interface SavedToolResult {
  ok?: boolean;
  data?: ToolResultMessage['details'];
  summary?: string;
  error?: string;
  errorCode?: ToolExecutionResult['errorCode'];
  errorDetails?: ToolExecutionResult['errorDetails'];
  content?: ToolResultMessage['content'];
  usage?: Usage;
  durationMs?: number;
}

/** Preserve the provider-facing result exactly, including multiple text and image parts. */
export function savedToolContent(result: SavedToolResult): ToolResultMessage['content'] {
  if (result.content !== undefined) return result.content;
  return toModelToolResult({ ...result, ok: result.ok !== false }).content;
}

export function savedToolMetadata(result: SavedToolResult): Pick<ToolResultMessage, 'usage' | 'durationMs'> {
  return { ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }) };
}
