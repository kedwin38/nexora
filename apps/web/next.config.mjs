/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server-mode Next (rewrites need it). Proxy API calls to the API service,
  // so the browser only ever talks to one origin.
  async rewrites() {
    // Use the API service's public domain as fallback when variable isn't set at build time.
    // The service is exposed publicly at https://nexoraapi-production-xxxx.up.railway.app
    // but for same-network calls, use the RAILWAY_PUBLIC_DOMAIN which resolves correctly.
    const apiBase = process.env.API_PROXY_URL || 'https://nexoraapi-production-596b.up.railway.app';
    return [{ source: '/api/:path*', destination: `${apiBase}/api/:path*` }];
  },
};

export default nextConfig;

