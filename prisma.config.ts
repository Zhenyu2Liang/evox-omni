import nextEnv from '@next/env';
import { defineConfig } from 'prisma/config';
import { resolveDatabaseUrl } from './lib/db/url.ts';

// Load the application's environment without overriding an explicitly selected isolated database.
nextEnv.loadEnvConfig(process.cwd(), false, { info: () => undefined,
  error: () => { throw new Error('Environment configuration could not be loaded.'); } });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { seed: 'tsx prisma/seed.ts' },
  datasource: { url: resolveDatabaseUrl() },
});
