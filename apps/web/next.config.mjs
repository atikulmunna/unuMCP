// The API runs behind the `/api` global prefix (see apps/api/src/main.ts).
// We proxy it through Next so the browser stays same-origin and the bearer
// token rides along without any CORS configuration on the backend.
const API_URL = process.env.API_URL ?? "http://localhost:3001";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
