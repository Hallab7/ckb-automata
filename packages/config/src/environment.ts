import { z } from "zod";

export const ENVIRONMENT_PROFILES = ["local", "test", "testnet-preview", "testnet-public"] as const;

export type EnvironmentProfile = (typeof ENVIRONMENT_PROFILES)[number];

export const AUTOMATA_ENV_KEYS = [
  "AUTOMATA_PROFILE",
  "CKB_NETWORK",
  "CKB_GENESIS_HASH",
  "CKB_RPC_URL",
  "CKB_INDEXER_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "PUBLIC_APP_ORIGIN",
] as const;

const commonFields = {
  CKB_GENESIS_HASH: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte hexadecimal hash"),
  CKB_INDEXER_URL: z.url(),
  CKB_RPC_URL: z.url(),
  DATABASE_URL: z.string().startsWith("postgresql://"),
  PUBLIC_APP_ORIGIN: z.url(),
  REDIS_URL: z
    .string()
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      "must use redis:// or rediss://",
    ),
};

const localEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("local"),
  CKB_NETWORK: z.literal("ckb_dev"),
});

const testEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("test"),
  CKB_NETWORK: z.literal("ckb_dev"),
});

const testnetPreviewEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("testnet-preview"),
  CKB_NETWORK: z.literal("ckb_testnet"),
});

const testnetPublicEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("testnet-public"),
  CKB_NETWORK: z.literal("ckb_testnet"),
});

export const EnvironmentSchema = z.discriminatedUnion("AUTOMATA_PROFILE", [
  localEnvironmentSchema,
  testEnvironmentSchema,
  testnetPreviewEnvironmentSchema,
  testnetPublicEnvironmentSchema,
]);

export type AutomataEnvironment = z.infer<typeof EnvironmentSchema>;

export function parseEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): AutomataEnvironment {
  const candidate = Object.fromEntries(AUTOMATA_ENV_KEYS.map((key) => [key, input[key]]));
  return EnvironmentSchema.parse(candidate);
}
