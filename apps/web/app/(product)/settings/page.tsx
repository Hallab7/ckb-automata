import type { Metadata } from "next";

import { SettingsPanel } from "../../../src/settings/settings.tsx";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return <SettingsPanel />;
}
