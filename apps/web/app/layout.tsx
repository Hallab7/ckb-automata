import type { Metadata } from "next";
import type { ReactNode } from "react";

import { CccProvider } from "../src/ccc/ccc-provider.tsx";
import { AnalyticsConsent } from "../src/privacy/analytics-consent.tsx";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CKB Automata",
    template: "%s | CKB Automata",
  },
  description: "Non-custodial automation for CKB testnet.",
  applicationName: "CKB Automata",
  icons: { icon: "/automata-mark.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <CccProvider>{children}</CccProvider>
        <AnalyticsConsent />
      </body>
    </html>
  );
}
