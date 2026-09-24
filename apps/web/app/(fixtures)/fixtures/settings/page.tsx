import type { Metadata } from "next";

import { SettingsFixture } from "../../../../src/settings/settings.fixture.tsx";

export const metadata: Metadata = {
  title: "Settings fixture",
};

export default function SettingsFixturePage() {
  return <SettingsFixture />;
}
