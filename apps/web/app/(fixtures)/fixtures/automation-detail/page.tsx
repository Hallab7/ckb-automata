import type { Metadata } from "next";

import { JobDetailFixture } from "../../../../src/detail/job-detail.fixture.tsx";

export const metadata: Metadata = {
  title: "Automation detail fixture",
};

export default function AutomationDetailFixturePage() {
  return <JobDetailFixture />;
}
