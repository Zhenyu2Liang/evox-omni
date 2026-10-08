/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Pi Agent SDK ships pre-compiled ESM and is server-only (it talks to LLM
  // providers). Marking it external keeps it out of the webpack bundle, avoiding
  // spurious "Cannot find module 'node:fs'/'node:os'/'node:path'" errors caused by
  // its dynamic runtime requires (e.g. dist/providers/openai-codex-responses.js).
  serverExternalPackages: ['@prisma/client', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core'],
};

export default nextConfig;
