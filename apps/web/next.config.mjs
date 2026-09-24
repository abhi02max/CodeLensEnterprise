/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The API is a separate service on :4000 with CORS configured for this origin, so the browser
  // talks to it directly rather than through a Next rewrite. Keeping the real API surface in the
  // network tab is worth more during a demo than hiding it behind a proxy.
  env: {},
  eslint: {
    // No ESLint config in this app yet; the root `pnpm lint` skips it via --if-present.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
