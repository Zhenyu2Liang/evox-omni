export interface AppConfig {
  llmMode: 'live' | 'mock';
  llmProvider: string;
  llmModel: string;
  demoUserId: string;
  contextCompaction?: {
    thresholdTokens?: number;
    reserveTokens?: number;
    keepRecentTokens?: number;
    summaryTokens?: number;
  };
}

function tokenSetting(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 128 && parsed <= 1000000 ? parsed : undefined;
}

/**
 * Reads the runtime configuration from the environment.
 * Read at call time (not module load) so tests can toggle `LLM_MODE` freely.
 */
export function getConfig(): AppConfig {
  return {
    llmMode: process.env.LLM_MODE === 'live' ? 'live' : 'mock',
    llmProvider: process.env.LLM_PROVIDER ?? 'openai',
    llmModel: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    demoUserId: process.env.DEMO_USER_ID ?? 'user_liming',
    contextCompaction: {
      thresholdTokens: tokenSetting(process.env.AGENT_COMPACTION_THRESHOLD_TOKENS),
      reserveTokens: tokenSetting(process.env.AGENT_COMPACTION_RESERVE_TOKENS),
      keepRecentTokens: tokenSetting(process.env.AGENT_COMPACTION_KEEP_RECENT_TOKENS),
      summaryTokens: tokenSetting(process.env.AGENT_COMPACTION_SUMMARY_TOKENS),
    },
  };
}
