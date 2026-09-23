import { Suspense } from "react";

import { RecurringSetup } from "../../../../../src/setup/recurring-setup.tsx";

export default function NewRecurringAutomationPage() {
  return (
    <Suspense fallback={null}>
      <RecurringSetup />
    </Suspense>
  );
}
