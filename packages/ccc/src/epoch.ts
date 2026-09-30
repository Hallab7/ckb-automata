import {
  createEpoch,
  packEpoch,
  parseEpoch,
  type EpochValue,
  type IntegerInput,
} from "@ckb-automata/core";

interface ClientEpoch {
  readonly integer: IntegerInput;
  readonly numerator: IntegerInput;
  readonly denominator: IntegerInput;
}

function isPackedEpoch(value: unknown): value is IntegerInput {
  return typeof value === "bigint" || typeof value === "string";
}

export function packClientEpoch(value: unknown): EpochValue {
  if (isPackedEpoch(value)) return packEpoch(parseEpoch(value));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("client epoch must be a packed integer or epoch fraction");
  }
  const epoch = value as Partial<ClientEpoch>;
  if (
    epoch.integer === undefined ||
    epoch.numerator === undefined ||
    epoch.denominator === undefined
  ) {
    throw new TypeError("client epoch fraction is incomplete");
  }
  return packEpoch(
    createEpoch({
      number: epoch.integer,
      index: epoch.numerator,
      length: epoch.denominator,
    }),
  );
}
