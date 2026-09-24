import type { Metadata } from "next";

import { createDemoDataProvider } from "../../../src/data-provider.ts";
import { ScaffoldPage } from "../../../src/scaffold/scaffold-page.tsx";

export const metadata: Metadata = {
  title: "Demo",
};

export default function DemoPage() {
  const provider = createDemoDataProvider(null);
  return (
    <ScaffoldPage
      description="Fixture-backed walkthrough with no wallet or testnet requests."
      detail={provider.label}
      title="Demo"
    />
  );
}
