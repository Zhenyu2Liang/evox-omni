import type { AppConfig } from '@/lib/config';
import type { SessionSnapshot } from '@/agent/session';
import { AppError } from '@/lib/errors';
import { encodeRuntimeValue } from './serialization';

export interface RunCheckpoint {
  version: 1;
  snapshot: SessionSnapshot;
  provider: Pick<AppConfig, 'llmMode' | 'llmProvider' | 'llmModel'>;
  inputMessagePersisted?: boolean;
}

export function encodeCheckpoint(snapshot: SessionSnapshot, config: AppConfig): string {
  return encodeRuntimeValue({ version: 1, snapshot, provider: { llmMode: config.llmMode, llmProvider: config.llmProvider, llmModel: config.llmModel } });
}

export function decodeCheckpoint(json: string, config: AppConfig): RunCheckpoint {
  const checkpoint = JSON.parse(json) as RunCheckpoint;
  if (checkpoint.version !== 1 || !checkpoint.snapshot || !Array.isArray(checkpoint.snapshot.agentState?.messages) || !Array.isArray(checkpoint.snapshot.transcript)) throw new AppError('CONFLICT', 'The run checkpoint is incomplete');
  const provider = checkpoint.provider;
  if (!provider || provider.llmMode !== config.llmMode || provider.llmProvider !== config.llmProvider || provider.llmModel !== config.llmModel) throw new AppError('CONFLICT', 'The original provider configuration is required for continuation');
  return checkpoint;
}

export function hasRedactedCredentials(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('[REDACTED');
  if (Array.isArray(value)) return value.some(hasRedactedCredentials);
  return typeof value === 'object' && value !== null && Object.values(value).some(hasRedactedCredentials);
}
