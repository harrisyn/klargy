import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  // `standalone` gives a self-contained server for the Docker image; Vercel
  // ignores it.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // AGENTS.md and CLAUDE.md are tracked here; stop `next dev` from
  // (re)writing them on every start.
  agentRules: false,
  outputFileTracingRoot: path.join(__dirname),
  // Server-only packages that must stay as Node requires rather than being
  // bundled (native bindings / dynamic requires).
  serverExternalPackages: ['@prisma/client', 'prisma', 'bcryptjs', 'nodemailer', 'multer', 'express'],
  // Docker on Windows/Mac can't see file changes on bind mounts, so dev in
  // Docker uses webpack with polling (`next dev --webpack`, see
  // Dockerfile.dev). Builds use Turbopack, which rejects a webpack config,
  // so it is only added when polling is asked for.
  ...(process.env.WATCHPACK_POLLING === 'true'
    ? {
        webpack: (config: { watchOptions?: unknown }, { dev }: { dev: boolean }) => {
          if (dev) config.watchOptions = { poll: 1000, aggregateTimeout: 300 };
          return config;
        },
      }
    : {}),
};

export default nextConfig;
