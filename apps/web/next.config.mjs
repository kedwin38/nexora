/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server-mode Next (rewrites need it). Proxy API calls to the API service,
  // so the browser only ever talks to one origin.
  async rewrites() {
    const apiBase = process.env.API_PROXY_URL ?? 'http://localhost:5000';
    return [{ source: '/api/:path*', destination: `${apiBase}/api/:path*` }];
  },
};

export default nextConfig;
