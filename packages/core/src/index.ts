export const WORKSPACE_NAME = "ckb-automata" as const;

export {
  JOB_ID_DOMAIN,
  deriveJobId,
  type CreationAnchor,
  type JobIdentityInput,
} from "./job-identity.ts";

export {
  ERROR_CATALOG,
  INVALID_TRANSITION_DIAGNOSTICS,
  getErrorDefinition,
  type ErrorDefinition,
  type ErrorDomain,
  type ErrorKey,
  type ScriptErrorKey,
} from "./errors.ts";

export {
  CANONICAL_TERMS,
  CANONICAL_TRANSACTION_STATES,
  GLOSSARY,
  type CanonicalTerm,
  type CanonicalTransactionState,
} from "./vocabulary.ts";
