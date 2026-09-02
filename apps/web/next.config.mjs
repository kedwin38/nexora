/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server-mode Next (rewrites need it). Proxy API calls to the API service.
  // Use the private network DNS name so rewrites work regardless of deployment.
  async rewrites() {
    // At build time, use private network. At runtime, process.env.API_PROXY_URL
    // from Railway variables can override this if set.
    const apiBase = process.env.API_PROXY_URL || 'http://api.railway.internal';
    return [{ source: '/api/:path*', destination: `${apiBase}/api/:path*` }];
  },
};

export default nextConfig;

