import type { Metadata } from "next";

import { AutomationDashboardFixture } from "../../../../src/dashboard/dashboard.fixture.tsx";

export const metadata: Metadata = {
  title: "Automation dashboard fixture",
};

export default function AutomationDashboardFixturePage() {
  return <AutomationDashboardFixture />;
}
