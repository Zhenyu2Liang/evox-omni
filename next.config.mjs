/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@mariozechner/pi-ai', '@mariozechner/pi-agent-core'],
  serverExternalPackages: ['@prisma/client'],
};

export default nextConfig;
