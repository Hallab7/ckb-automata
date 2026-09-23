import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CKB Automata",
    template: "%s | CKB Automata",
  },
  description: "Non-custodial automation for CKB testnet.",
  applicationName: "CKB Automata",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
