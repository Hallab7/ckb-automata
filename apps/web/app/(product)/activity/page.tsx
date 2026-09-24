import type { Metadata } from "next";

import { ActivityFeed } from "../../../src/activity/activity.tsx";

export const metadata: Metadata = {
  title: "Activity",
};

export default function ActivityPage() {
  return <ActivityFeed />;
}
