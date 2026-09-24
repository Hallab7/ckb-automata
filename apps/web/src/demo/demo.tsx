"use client";

import { ArrowRight, Beaker, Check, Circle, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@ckb-automata/ui";

import type { DemoScenario } from "./demo-data.ts";

export function DemoExperience({
  dataLabel,
  scenarios,
}: Readonly<{ dataLabel: string; scenarios: readonly DemoScenario[] }>) {
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.id);
  const [stepIndex, setStepIndex] = useState(0);
  const scenario = useMemo(
    () => scenarios.find((candidate) => candidate.id === scenarioId) ?? scenarios[0],
    [scenarioId, scenarios],
  );

  if (scenario === undefined) return null;
  const currentStep = scenario.walkthrough[stepIndex] ?? scenario.walkthrough[0];
  const lastStep = stepIndex === scenario.walkthrough.length - 1;

  const reset = () => {
    setScenarioId(scenarios[0]?.id);
    setStepIndex(0);
  };

  return (
    <section className="app-page demo-workspace" aria-labelledby="demo-title">
      <div className="demo-boundary" role="status">
        <Beaker aria-hidden="true" size={18} />
        <div>
          <strong>{dataLabel}</strong>
          <span>Simulated records. No wallet request, transaction, or chain evidence.</span>
        </div>
      </div>

      <header className="app-page-header demo-header">
        <div className="app-page-header__copy">
          <h1 id="demo-title">Guided automation scenarios</h1>
          <p>Deterministic examples of scheduling, execution, and owner recovery.</p>
        </div>
        <div className="app-page-header__actions">
          <Button
            icon={<RotateCcw aria-hidden="true" size={16} />}
            onClick={reset}
            tone="secondary"
          >
            Reset demo
          </Button>
        </div>
      </header>

      <div aria-label="Demo scenario" className="demo-scenario-switcher" role="group">
        {scenarios.map((candidate) => (
          <button
            aria-pressed={candidate.id === scenario.id}
            key={candidate.id}
            onClick={() => {
              setScenarioId(candidate.id);
              setStepIndex(0);
            }}
            type="button"
          >
            <span>{candidate.name}</span>
            <small>{candidate.status}</small>
          </button>
        ))}
      </div>

      <div className="demo-overview">
        <section className="demo-scenario" aria-labelledby="demo-scenario-title">
          <div className="demo-section-heading">
            <div>
              <p>Seeded scenario</p>
              <h2 id="demo-scenario-title">{scenario.name}</h2>
            </div>
            <span className={`ui-status ui-status--${scenario.tone}`}>{scenario.status}</span>
          </div>
          <p className="demo-scenario__summary">{scenario.summary}</p>
          <dl className="demo-facts">
            {scenario.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="demo-guide" aria-labelledby="demo-guide-title">
          <div className="demo-section-heading">
            <div>
              <p>
                Step {stepIndex + 1} of {scenario.walkthrough.length}
              </p>
              <h2 id="demo-guide-title">Guided review</h2>
            </div>
          </div>
          <ol aria-label="Scenario review progress" className="demo-guide__progress">
            {scenario.walkthrough.map((step, index) => (
              <li data-active={index === stepIndex ? "true" : undefined} key={step.label}>
                <button onClick={() => setStepIndex(index)} type="button">
                  {index < stepIndex ? (
                    <Check aria-hidden="true" size={14} />
                  ) : (
                    <Circle aria-hidden="true" size={13} />
                  )}
                  <span>{step.label}</span>
                </button>
              </li>
            ))}
          </ol>
          {currentStep === undefined ? null : (
            <div className="demo-guide__step" aria-live="polite">
              <h3>{currentStep.title}</h3>
              <p>{currentStep.body}</p>
            </div>
          )}
          <Button
            icon={
              lastStep ? (
                <RotateCcw aria-hidden="true" size={16} />
              ) : (
                <ArrowRight aria-hidden="true" size={16} />
              )
            }
            onClick={() => setStepIndex(lastStep ? 0 : stepIndex + 1)}
          >
            {lastStep ? "Restart scenario" : "Next review"}
          </Button>
        </section>
      </div>

      <section className="demo-timeline" aria-labelledby="demo-timeline-title">
        <div className="demo-section-heading">
          <div>
            <p>Simulated evidence</p>
            <h2 id="demo-timeline-title">Activity timeline</h2>
          </div>
        </div>
        <ol>
          {scenario.timeline.map((event) => (
            <li key={`${event.label}:${event.state}`}>
              <span aria-hidden="true" />
              <div>
                <strong>{event.label}</strong>
                <p>{event.detail}</p>
              </div>
              <small>{event.state}</small>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
