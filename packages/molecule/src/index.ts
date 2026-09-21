export const MOLECULE_PACKAGE_READY = true;

export {
  Byte32 as CampaignByte32,
  CampaignDataV1,
  CAMPAIGN_V1_SCHEMA_SHA256,
  Uint16 as CampaignUint16,
  Uint32 as CampaignUint32,
  Uint64 as CampaignUint64,
  type CampaignDataV1Like,
  type CampaignDataV1Value,
} from "./generated/campaign_v1.ts";

export {
  Byte32,
  JobDataV1,
  JOB_V1_SCHEMA_SHA256,
  Uint16,
  Uint32,
  Uint64,
  type JobDataV1Like,
  type JobDataV1Value,
} from "./generated/job_v1.ts";

export {
  Byte32 as RecurringByte32,
  RECURRING_V1_SCHEMA_SHA256,
  RecurringPayloadV1,
  Uint16 as RecurringUint16,
  Uint32 as RecurringUint32,
  Uint64 as RecurringUint64,
  type RecurringPayloadV1Like,
  type RecurringPayloadV1Value,
} from "./generated/recurring_v1.ts";
