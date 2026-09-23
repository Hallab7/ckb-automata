import type { Metadata } from "next";

import { VisualSystemFixture } from "@ckb-automata/ui/visual-system-fixture";

export const metadata: Metadata = {
  title: "Visual system fixture",
  robots: { index: false, follow: false },
};

export default function VisualSystemFixturePage() {
  return <VisualSystemFixture />;
}
