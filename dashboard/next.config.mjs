/**
 * planning_update.md P2 (path "a"): the dashboard is a static export, never `next start` and never a server component that
 * reads the filesystem. `p2o dashboard snapshot` copies `dashboard/out` into the snapshot directory next to the data tree, and
 * the repo's own `node dist/src/dashboard/main.js serve --snapshot <dir>` (or any static file server) serves it.
 *
 * `trailingSlash` makes every route a directory with an `index.html`, so the static server needs no extension guessing and the
 * snapshot stays zip-able (owner decision m6).
 *
 * Telemetry is disabled here as well as in the npm script: this dashboard is a local read-only surface, and a build that
 * phones home would be an external call the design says it does not make.
 */

process.env.NEXT_TELEMETRY_DISABLED = '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
