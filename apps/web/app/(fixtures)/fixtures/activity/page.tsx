import type { Metadata } from "next";

import { ActivityFixture } from "../../../../src/activity/activity.fixture.tsx";

export const metadata: Metadata = {
  title: "Activity fixture",
};

export default function ActivityFixturePage() {
  return <ActivityFixture />;
}
