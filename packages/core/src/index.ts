export const WORKSPACE_NAME = "ckb-automata" as const;

export {
  MAX_EPOCH_COMPONENT,
  MAX_EPOCH_NUMBER,
  MAX_EPOCH_VALUE,
  MAX_UINT32,
  MAX_UINT64,
  createEpoch,
  hash32FromBytes,
  hash32ToBytes,
  outPointToRpc,
  packEpoch,
  parseBlockNumber,
  parseEpoch,
  parseEpochIndex,
  parseEpochLength,
  parseEpochNumber,
  parseHash32,
  parseOutPoint,
  parseOutputIndex,
  parseRunCount,
  parseSequence,
  parseShannons,
  toRpcHex,
  uint32ToLittleEndian,
  uint64ToLittleEndian,
  type BlockNumber,
  type Epoch,
  type EpochIndex,
  type EpochLength,
  type EpochNumber,
  type EpochValue,
  type Hash32,
  type IntegerInput,
  type OutPoint,
  type OutputIndex,
  type RpcOutPoint,
  type RunCount,
  type Sequence,
  type Shannons,
  type Uint32Value,
  type Uint64Value,
} from "./chain-values.ts";

export {
  CONTRACT_CAPACITY,
  minimumCampaignCellCapacity,
  minimumJobCellCapacity,
  type ContractCapacityId,
} from "./contract-costs.ts";

export {
  CAMPAIGN_STATES,
  determineCampaignOutcome,
  isAbsoluteBlockDeadline,
  type CampaignOutcome,
} from "./campaign.ts";

export {
  JOB_ID_DOMAIN,
  deriveJobId,
  type CreationAnchor,
  type JobIdentityInput,
} from "./job-identity.ts";

export {
  POLICY_PAYLOAD_DOMAIN,
  deriveRecurringPayloadHash,
  isValidRecurringSchedule,
  type RecurringSchedule,
} from "./recurring.ts";

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
