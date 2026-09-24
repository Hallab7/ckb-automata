import type { Metadata } from "next";
import { Suspense } from "react";

import { SetupStepperFixture } from "../../../../src/setup/setup-stepper.fixture.tsx";

export const metadata: Metadata = {
  title: "Deadline setup fixture",
};

export default function DeadlineSetupFixturePage() {
  return (
    <Suspense fallback={null}>
      <SetupStepperFixture template="deadline" />
    </Suspense>
  );
}
