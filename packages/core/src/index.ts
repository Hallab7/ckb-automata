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
  parseSince,
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
  type SinceValue,
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
  CAMPAIGN_ID_DOMAIN,
  CAMPAIGN_REFUNDS_DOMAIN,
  CAMPAIGN_STATES,
  DEADLINE_PAYLOAD_VERSION,
  deriveCampaignId,
  deriveDeadlinePayloadHash,
  deriveRefundCommitment,
  determineCampaignOutcome,
  encodeOutPoint,
  isAbsoluteBlockDeadline,
  type CampaignOutcome,
} from "./campaign.ts";

export {
  ABSOLUTE_BLOCK_TRIGGER_KIND,
  TRIGGER_PARAMS_DOMAIN,
  deriveAbsoluteBlockTriggerHash,
} from "./triggers.ts";

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

export {
  DEPLOYED_CONTRACT_NAMES,
  inspectJobData,
  validateDeploymentManifest,
  type CellDepIdentity,
  type DeployedContract,
  type DeployedContractName,
  type DeploymentManifest,
  type InspectedJobDataV1,
  type JobInspectionOptions,
  type JobInspectionResult,
  type JobSemanticIssue,
  type ManifestIssue,
  type ManifestValidationResult,
  type PolicyMetadata,
  type ScriptHashType,
  type ScriptIdentity,
} from "./job-inspection.ts";

export {
  LOCAL_DEPLOYMENT_MANIFEST_SHA256,
  createDeploymentRegistry,
  deploymentRegistry,
  hashDeploymentManifest,
  type DeploymentRegistry,
  type DeploymentRegistryLoadResult,
  type HashedManifestEntry,
  type RegisteredContract,
  type RegisteredDeployment,
} from "./deployment-registry.ts";

export {
  calculateDeadlineQuote,
  calculateRecurringQuote,
  estimateTransactionFeeRange,
  type DeadlineQuote,
  type DeadlineQuoteInput,
  type EstimatedFeeRange,
  type FeeRangeInput,
  type QuoteAmounts,
  type RecurringQuote,
  type RecurringQuoteInput,
} from "./quotes.ts";

export {
  DEADLINE_CREATION_INTENT_DOMAIN,
  assertDeadlineCompletion,
  buildDeadlineCreation,
  type DeadlineCompletionContract,
  type DeadlineCreationBuild,
  type DeadlineCreationInput,
  type DeadlinePledgeInput,
  type NormalizedDeadlineIntent,
  type UnsignedCellInput,
  type UnsignedCellOutput,
  type UnsignedDeadlineTransaction,
} from "./deadline-creation.ts";

export {
  RECURRING_CREATION_INTENT_DOMAIN,
  assertRecurringCompletion,
  buildRecurringCreation,
  reconstructRecurringDisplayIntent,
  type NormalizedRecurringIntent,
  type RecurringCreationBuild,
  type RecurringCreationInput,
  type RecurringDisplayIntent,
} from "./recurring-creation.ts";

export {
  CANCELLATION_OPERATION,
  CancellationBuildError,
  assertCancellationCompletion,
  buildCancellation,
  type CancellationBuild,
  type CancellationErrorCode,
  type CancellationInput,
  type LiveCellResolver,
  type ResolvedLiveCell,
} from "./cancellation.ts";

export {
  RECOVERY_OPERATION,
  RECOVERY_REASONS,
  RecoveryBuildError,
  assertRecoveryCompletion,
  buildRecovery,
  type RecoveryBuild,
  type RecoveryErrorCode,
  type RecoveryInput,
  type RecoveryOutputPreview,
  type RecoveryReason,
} from "./recovery.ts";

export {
  TOP_UP_OPERATION,
  TopUpBuildError,
  assertTopUpCompletion,
  buildTopUp,
  inspectTopUpDiff,
  type JobCellSnapshot,
  type TopUpBuild,
  type TopUpDiff,
  type TopUpErrorCode,
  type TopUpInput,
} from "./top-up.ts";
