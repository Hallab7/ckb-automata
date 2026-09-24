import {
  BellRing,
  CheckCircle2,
  ExternalLink,
  FlaskConical,
  Landmark,
  Repeat2,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { InlineNotice } from "@ckb-automata/ui";

import { NervDaoEpochCalculator } from "./nervdao-calculator.tsx";

const prerequisites = [
  "Exact epoch fractions and required headers are derived from confirmed chain data.",
  "A constrained vault policy preserves owner recovery without general private-key custody.",
  "Live DAO and fee cells are revalidated before every state transition.",
  "Contract review, testnet evidence, measured economics, and maintainer acceptance are complete.",
] as const;

const sources = [
  {
    description: "Normative two-step withdrawal rules, epoch maturity, and compensation formula.",
    href: "https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0023-dao-deposit-withdraw/0023-dao-deposit-withdraw.md",
    label: "Nervos RFC 23",
  },
  {
    description: "Deployed DAO validation logic and the 180-epoch lock-period constant.",
    href: "https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/dao.c",
    label: "CKB DAO system script",
  },
  {
    description: "Current wallet interface and its explanation of automatic compounding.",
    href: "https://github.com/ckb-devrel/nervdao",
    label: "NervDAO source",
  },
  {
    description: "Reference helpers for DAO compensation and claim-epoch calculation.",
    href: "https://github.com/ckb-devrel/ccc/blob/ab98c7a772226cef78e865f6b37e83e7e2f57d66/packages/core/src/ckb/transaction.ts",
    label: "CCC DAO helpers",
  },
] as const;

export function NervDaoResearchPreview() {
  return (
    <article className="app-page nervdao-research" aria-labelledby="nervdao-title">
      <header className="app-page-header nervdao-hero">
        <div className="app-page-header__copy">
          <div className="nervdao-kicker">
            <FlaskConical aria-hidden="true" size={16} /> Research preview
          </div>
          <h1 id="nervdao-title">NervDAO cycle automation</h1>
          <p>
            A researched future adapter for timing support and compensation harvesting. It is not an
            available Automata workflow.
          </p>
        </div>
        <span className="ui-status ui-status--warning">Research only</span>
      </header>

      <InlineNotice title="No wallet interaction" tone="warning">
        <p>
          This page provides explanatory calculations only. It does not connect to a deposit, submit
          a transaction, reserve funds, or change on-chain state.
        </p>
      </InlineNotice>

      <section className="nervdao-concepts" aria-labelledby="candidate-concepts-title">
        <div className="nervdao-section-heading nervdao-section-heading--wide">
          <span className="nervdao-section-icon" aria-hidden="true">
            <Landmark size={20} />
          </span>
          <div>
            <h2 id="candidate-concepts-title">Two candidate concepts</h2>
            <p>Distinct risk levels, both still behind research gates.</p>
          </div>
        </div>
        <div className="nervdao-concepts__grid">
          <article className="nervdao-concept">
            <BellRing aria-hidden="true" size={22} />
            <div>
              <div className="nervdao-concept__title">
                <h3>Cycle Guard</h3>
                <span className="ui-status ui-status--info">Lower risk</span>
              </div>
              <p>
                Epoch-aware reminders help a depositor approach the preferred first withdrawal
                window while retaining direct wallet control.
              </p>
              <strong>Candidate outcome</strong>
              <span>Clear timing, stale-cell detection, and a later manual claim.</span>
            </div>
          </article>
          <article className="nervdao-concept">
            <Repeat2 aria-hidden="true" size={22} />
            <div>
              <div className="nervdao-concept__title">
                <h3>Harvest Compensation</h3>
                <span className="ui-status ui-status--warning">Advanced research</span>
              </div>
              <p>
                A constrained policy could claim matured compensation, return it to an owner-chosen
                address, and redeposit the configured principal atomically.
              </p>
              <strong>Candidate outcome</strong>
              <span>Periodic cash flow, with added contract, timing, and fee risk.</span>
            </div>
          </article>
        </div>
      </section>

      <NervDaoEpochCalculator />

      <section className="nervdao-return-warning" aria-labelledby="return-warning-title">
        <div className="nervdao-section-heading">
          <span className="nervdao-section-icon nervdao-section-icon--warning" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <div>
            <h2 id="return-warning-title">Annualized estimates need context</h2>
            <p>Compensation is not a fixed monthly payout or a yield boost from harvesting.</p>
          </div>
        </div>
        <div className="nervdao-return-warning__body">
          <p>
            Nervos DAO compensation is calculated from the accumulated-rate change between the
            deposit and first withdrawal headers. Funds already compound while they remain
            deposited; periodic harvesting makes accrued compensation liquid but can add fees and
            time outside the DAO.
          </p>
          <p>
            Any annualized percentage is a point-in-time estimate. Exact compensation depends on the
            deposit&apos;s real headers, occupied capacity, and the chain&apos;s changing
            accumulated rate.
          </p>
        </div>
      </section>

      <section className="nervdao-prerequisites" aria-labelledby="security-prerequisites-title">
        <div className="nervdao-section-heading nervdao-section-heading--wide">
          <span className="nervdao-section-icon" aria-hidden="true">
            <ShieldCheck size={20} />
          </span>
          <div>
            <h2 id="security-prerequisites-title">Required before implementation</h2>
            <p>These gates keep the preview separate from a deployable adapter.</p>
          </div>
        </div>
        <ul>
          {prerequisites.map((prerequisite) => (
            <li key={prerequisite}>
              <CheckCircle2 aria-hidden="true" size={18} />
              <span>{prerequisite}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="nervdao-sources" aria-labelledby="research-sources-title">
        <div className="nervdao-section-heading nervdao-section-heading--wide">
          <span className="nervdao-section-icon" aria-hidden="true">
            <FlaskConical size={20} />
          </span>
          <div>
            <h2 id="research-sources-title">Primary research sources</h2>
            <p>Protocol and implementation references used for this preview.</p>
          </div>
        </div>
        <div className="nervdao-sources__list">
          {sources.map((source) => (
            <a href={source.href} key={source.href} rel="noreferrer" target="_blank">
              <span>
                <strong>{source.label}</strong>
                <small>{source.description}</small>
              </span>
              <ExternalLink aria-hidden="true" size={17} />
            </a>
          ))}
        </div>
      </section>
    </article>
  );
}
