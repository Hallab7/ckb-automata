import { Suspense } from "react";

import { SetupStepper } from "./setup-stepper.tsx";
import type { SetupTemplateId } from "./setup-flow.ts";

function SetupLoading({ template }: Readonly<{ template: SetupTemplateId }>) {
  return (
    <section
      className="app-page setup-flow"
      aria-busy="true"
      aria-label={`Loading ${template} setup`}
    >
      <div className="app-loading">
        <span className="app-loading__bar" />
        <span className="app-loading__bar app-loading__bar--short" />
      </div>
    </section>
  );
}

export function AutomationSetup({ template }: Readonly<{ template: SetupTemplateId }>) {
  return (
    <Suspense fallback={<SetupLoading template={template} />}>
      <SetupStepper template={template} />
    </Suspense>
  );
}
