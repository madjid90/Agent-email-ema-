import type { NextConfig } from "next";

/**
 * En-têtes de sécurité (phase 8). La CSP autorise `unsafe-inline` pour les
 * scripts : Next.js injecte ses propres scripts inline et EMA n'utilise pas de
 * nonce. Aucune ressource externe n'est chargée (pas de CDN, pas de police
 * distante), donc `default-src 'self'` suffit. `frame-ancestors 'none'`
 * interdit l'inclusion dans une iframe ; les redirections OAuth Microsoft sont
 * des navigations de premier niveau et ne sont pas affectées.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const productionHeaders = [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 est un module natif : il doit rester hors du bundle Next.
  serverExternalPackages: ["better-sqlite3", "pdf-parse"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: process.env.NODE_ENV === "production" ? [...securityHeaders, ...productionHeaders] : securityHeaders,
      },
    ];
  },
};

export default nextConfig;
