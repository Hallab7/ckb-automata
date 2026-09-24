import type { ReactNode } from "react";

import { PublicDeploymentGate } from "../../src/public-deployment-gate.tsx";
import { AppShell } from "../../src/shell/app-shell.tsx";

export default function ProductLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AppShell>
      <PublicDeploymentGate>{children}</PublicDeploymentGate>
    </AppShell>
  );
}
