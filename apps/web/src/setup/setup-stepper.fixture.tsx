"use client";

import { TextField } from "@ckb-automata/ui";

import { SetupStepper, type SetupStepRenderContext } from "./setup-stepper.tsx";
import type { SetupErrors, SetupStepId } from "./setup-flow.ts";

const INITIAL_DRAFT = Object.freeze({ fixtureName: "" });

function validateFixture(step: SetupStepId, draft: Readonly<Record<string, string>>): SetupErrors {
  return step === "details" && !draft["fixtureName"]?.trim()
    ? { fixtureName: "Enter a fixture name." }
    : {};
}

function FixtureStep({ draft, errors, setField, step }: SetupStepRenderContext) {
  if (step === "details") {
    return (
      <div className="setup-step__group">
        <h2>Details</h2>
        <TextField
          {...(errors["fixtureName"] === undefined ? {} : { error: errors["fixtureName"] })}
          label="Fixture name"
          name="fixtureName"
          onChange={(event) => setField("fixtureName", event.target.value)}
          value={draft["fixtureName"] ?? ""}
        />
      </div>
    );
  }
  return (
    <div className="setup-step__group">
      <h2>{step.replace("_", " ")}</h2>
      <p data-preserved-value={draft["fixtureName"]}>{draft["fixtureName"]}</p>
    </div>
  );
}

export function SetupStepperFixture() {
  return (
    <SetupStepper
      initialDraft={INITIAL_DRAFT}
      renderStep={(context) => <FixtureStep {...context} />}
      storageId="fixture"
      template="deadline"
      validateStep={validateFixture}
    />
  );
}
