import type { NextConfig } from "next";

const config = Object.freeze({
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
