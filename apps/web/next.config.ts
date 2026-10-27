import { config } from 'dotenv';
import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Monorepo: a single .env at the repo root. Platform env vars take precedence in production.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The monorepo root, so server files traced from packages/ are included (and a stray lockfile
  // elsewhere on the machine isn't mistaken for the workspace root).
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@autodev/ui', '@autodev/config', '@autodev/crypto', '@autodev/db', '@autodev/github', '@autodev/protocol'],
  serverExternalPackages: ['postgres'],
  // Same-origin proxy, so the Auth.js session cookie reaches the API without CORS.
  async rewrites() {
    return [
      { source: '/api/trpc/:path*', destination: `${API_URL}/trpc/:path*` },
      { source: '/api/github/:path*', destination: `${API_URL}/github/:path*` },
      { source: '/api/events', destination: `${API_URL}/events` },
      { source: '/api/billing/:path*', destination: `${API_URL}/billing/:path*` },
      { source: '/api/audit/:path*', destination: `${API_URL}/audit/:path*` },
      { source: '/api/sso/:path*', destination: `${API_URL}/sso/:path*` },
    ];
  },
  images: { remotePatterns: [{ protocol: 'https', hostname: 'avatars.githubusercontent.com' }] },
};

export default nextConfig;
