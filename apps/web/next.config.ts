import type { NextConfig } from "next";

const development = process.env.NODE_ENV === "development";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${development ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(development ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders: { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-XSS-Protection", value: "0" },
];

const config = Object.freeze({
  headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders }]),
  poweredByHeader: false,
  reactStrictMode: true,
  redirects: () =>
    Promise.resolve([
      {
        source: "/",
        destination: "/automations",
        permanent: false,
      },
    ]),
} satisfies NextConfig);

export default config;
