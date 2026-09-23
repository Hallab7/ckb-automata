import type { Metadata } from "next";
import { Suspense } from "react";

import { SetupStepperFixture } from "../../../../src/setup/setup-stepper.fixture.tsx";

export const metadata: Metadata = {
  title: "Setup stepper fixture",
};

export default function SetupStepperFixturePage() {
  return (
    <Suspense fallback={null}>
      <SetupStepperFixture />
    </Suspense>
  );
}
