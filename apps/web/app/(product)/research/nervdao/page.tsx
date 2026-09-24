import type { Metadata } from "next";

import { NervDaoResearchPreview } from "../../../../src/research/nervdao-preview.tsx";

export const metadata: Metadata = {
  title: "NervDAO research",
};

export default function NervDaoResearchPage() {
  return <NervDaoResearchPreview />;
}
