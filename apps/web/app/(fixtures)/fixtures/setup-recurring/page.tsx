import type { Metadata } from "next";
import { Suspense } from "react";

import { SetupStepperFixture } from "../../../../src/setup/setup-stepper.fixture.tsx";

export const metadata: Metadata = {
  title: "Recurring setup fixture",
};

export default function RecurringSetupFixturePage() {
  return (
    <Suspense fallback={null}>
      <SetupStepperFixture template="recurring" />
    </Suspense>
  );
}
