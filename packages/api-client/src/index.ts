import { CANONICAL_TRANSACTION_STATES } from "@ckb-automata/core";

export const API_CLIENT_PACKAGE_READY = true;

export const API_TRANSACTION_STATE_VALUES = CANONICAL_TRANSACTION_STATES;

export type ApiTransactionState = (typeof API_TRANSACTION_STATE_VALUES)[number];
