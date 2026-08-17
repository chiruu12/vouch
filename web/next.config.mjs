/** @type {import('next').NextConfig} */
const nextConfig = {
  // The feed renders a snapshot the supervision cycle wrote, so there is nothing to
  // render per-request. Static export keeps that honest: a page that cannot call out
  // cannot quietly start scraping at request time.
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
