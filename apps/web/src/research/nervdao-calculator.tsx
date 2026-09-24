"use client";

import { Calculator, Clock3, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { InlineNotice, TextField } from "@ckb-automata/ui";

import { calculateEpochWindow } from "./nervdao-model.ts";

export function NervDaoEpochCalculator() {
  const [depositEpoch, setDepositEpoch] = useState("1000");
  const [currentEpoch, setCurrentEpoch] = useState("1240");
  const [preparationBuffer, setPreparationBuffer] = useState("6");
  const calculation = useMemo(() => {
    try {
      return { result: calculateEpochWindow({ currentEpoch, depositEpoch, preparationBuffer }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The epoch values are invalid." };
    }
  }, [currentEpoch, depositEpoch, preparationBuffer]);

  return (
    <section className="nervdao-calculator" aria-labelledby="epoch-calculator-title">
      <div className="nervdao-section-heading">
        <span className="nervdao-section-icon" aria-hidden="true">
          <Calculator size={20} />
        </span>
        <div>
          <h2 id="epoch-calculator-title">Illustrative epoch window</h2>
          <p>Explore how a 180-epoch cadence moves the next boundary.</p>
        </div>
      </div>

      <div className="nervdao-calculator__fields">
        <TextField
          inputMode="numeric"
          label="Deposit epoch"
          min="0"
          onChange={(event) => setDepositEpoch(event.target.value)}
          type="number"
          value={depositEpoch}
        />
        <TextField
          inputMode="numeric"
          label="Current epoch"
          min="0"
          onChange={(event) => setCurrentEpoch(event.target.value)}
          type="number"
          value={currentEpoch}
        />
        <TextField
          hint="Illustrative lead time before the boundary"
          inputMode="numeric"
          label="Preparation buffer"
          max="179"
          min="1"
          onChange={(event) => setPreparationBuffer(event.target.value)}
          type="number"
          value={preparationBuffer}
        />
      </div>

      {calculation.result === undefined ? (
        <InlineNotice title="Check the epoch values" tone="danger">
          <p>{calculation.error}</p>
        </InlineNotice>
      ) : (
        <div className="nervdao-calculator__output" aria-live="polite">
          <div>
            <span>Next boundary</span>
            <strong>Epoch {calculation.result.nextBoundary.toLocaleString("en")}</strong>
            <small>Cycle {calculation.result.cycleNumber} after this deposit</small>
          </div>
          <div>
            <span>Window begins</span>
            <strong>Epoch {calculation.result.preparationStart.toLocaleString("en")}</strong>
            <small>
              {calculation.result.windowOpen ? "Illustrative window is open" : "Window is ahead"}
            </small>
          </div>
          <div>
            <span>Boundary distance</span>
            <strong>{calculation.result.remainingEpochs.toLocaleString("en")} epochs</strong>
            <small className="nervdao-time">
              <Clock3 aria-hidden="true" size={14} /> About {calculation.result.estimatedTime}
            </small>
          </div>
        </div>
      )}

      <div className="nervdao-calculator__caveat">
        <TriangleAlert aria-hidden="true" size={18} />
        <p>
          This estimate assumes four hours per epoch and ignores epoch fractions. Production logic
          must derive exact positions from confirmed chain headers.
        </p>
      </div>
    </section>
  );
}
