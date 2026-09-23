import type { ReactNode } from "react";

import { AppShell } from "../../src/shell/app-shell.tsx";

export default function ProductLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
