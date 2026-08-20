/** @type {import('next').NextConfig} */

// Security headers. The two that matter most here:
//   • frame-ancestors 'none' — /admin is a single-password panel with a logout
//     form and (later) tier overrides; without this it is clickjackable.
//   • img-src — every icon comes from the CommunityDragon CDN (see lib/icon-url.ts),
//     so that host has to be allowed explicitly once default-src is locked down.
//
// 'unsafe-inline' in script-src is required while Next injects its hydration and
// RSC-payload scripts inline; removing it means wiring a nonce through a custom
// middleware, which is a bigger change than this pass. Dev additionally needs
// 'unsafe-eval' and a websocket connection for HMR — hence the split.
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://raw.communitydragon.org",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Redundant with frame-ancestors for modern browsers; kept for older ones.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
];

// HSTS only once served over TLS — sending it from a plain-http dev server would
// pin localhost to https in the browser and be a nuisance to undo.
if (!isDev) {
  securityHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  });
}

const nextConfig = {
  // Don't advertise the framework version to scanners.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
