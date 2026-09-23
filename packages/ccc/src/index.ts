import { WORKSPACE_NAME } from "@ckb-automata/core";

export const CCC_PACKAGE_ID = `${WORKSPACE_NAME}:ccc` as const;

export {
  CkbClient,
  CkbClientError,
  createCkbClient,
  type CkbClientErrorCode,
  type CkbClientOptions,
  type CkbIndexerTip,
  type CkbReadClient,
} from "./client.ts";
