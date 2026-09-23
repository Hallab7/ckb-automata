import type { ReactNode } from "react";

import { AppShell } from "../../src/shell/app-shell.tsx";

export default function SetupLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
