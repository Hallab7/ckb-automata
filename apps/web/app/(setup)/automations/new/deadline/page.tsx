import { Suspense } from "react";

import { DeadlineSetup } from "../../../../../src/setup/deadline-setup.tsx";

export default function NewDeadlineAutomationPage() {
  return (
    <Suspense fallback={null}>
      <DeadlineSetup />
    </Suspense>
  );
}
