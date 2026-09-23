import type { Metadata } from "next";

import { WalletProviderFixture } from "../../../../src/ccc/provider.fixture.tsx";

export const metadata: Metadata = {
  title: "Wallet provider fixture",
  robots: { index: false, follow: false },
};

export default function WalletProviderFixturePage() {
  return <WalletProviderFixture />;
}
