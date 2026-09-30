export interface AppConfig {
  llmMode: 'live' | 'mock';
  llmProvider: string;
  llmModel: string;
  demoUserId: string;
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
  };
}
