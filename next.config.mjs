/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep acceptance and build artifacts separate from an active developer server.
  distDir: process.env.BANKING_NEXT_DIST_DIR ?? '.next',
  devIndicators: false,
  // Database and Pi runtimes execute on Node.js. External packages preserve their native
  // module loading under Next.js 16's default Turbopack bundler.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-better-sqlite3', 'better-sqlite3',
    '@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent'],
};

export default nextConfig;
