import type { Metadata } from "next";

import { createDemoDataProvider } from "../../../src/data-provider.ts";
import { DEMO_SCENARIOS } from "../../../src/demo/demo-data.ts";
import { DemoExperience } from "../../../src/demo/demo.tsx";

export const metadata: Metadata = {
  title: "Demo",
};

export default function DemoPage() {
  const provider = createDemoDataProvider(DEMO_SCENARIOS);
  return <DemoExperience dataLabel={provider.label} scenarios={provider.load()} />;
}
