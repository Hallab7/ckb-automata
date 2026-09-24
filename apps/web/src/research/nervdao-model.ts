export const DAO_CYCLE_EPOCHS = 180;
export const ESTIMATED_HOURS_PER_EPOCH = 4;
export const MAX_EPOCH_NUMBER = 0xff_ffff;

export interface EpochWindowInput {
  readonly currentEpoch: string;
  readonly depositEpoch: string;
  readonly preparationBuffer: string;
}

export interface EpochWindowResult {
  readonly cycleNumber: number;
  readonly estimatedTime: string;
  readonly nextBoundary: number;
  readonly preparationStart: number;
  readonly remainingEpochs: number;
  readonly windowOpen: boolean;
}

function parseInteger(value: string, label: string, minimum: number, maximum: number): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new TypeError(`${label} must be a whole number.`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function formatEstimatedTime(epochs: number): string {
  const hours = epochs * ESTIMATED_HOURS_PER_EPOCH;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days === 0) return `${remainingHours} hours`;
  if (remainingHours === 0) return `${days} ${days === 1 ? "day" : "days"}`;
  return `${days} ${days === 1 ? "day" : "days"}, ${remainingHours} hours`;
}

export function calculateEpochWindow(input: EpochWindowInput): EpochWindowResult {
  const depositEpoch = parseInteger(input.depositEpoch, "Deposit epoch", 0, MAX_EPOCH_NUMBER);
  const currentEpoch = parseInteger(input.currentEpoch, "Current epoch", 0, MAX_EPOCH_NUMBER);
  const preparationBuffer = parseInteger(
    input.preparationBuffer,
    "Preparation buffer",
    1,
    DAO_CYCLE_EPOCHS - 1,
  );
  if (currentEpoch < depositEpoch) {
    throw new RangeError("Current epoch cannot be earlier than the deposit epoch.");
  }

  const cycleNumber = Math.floor((currentEpoch - depositEpoch) / DAO_CYCLE_EPOCHS) + 1;
  const nextBoundary = depositEpoch + cycleNumber * DAO_CYCLE_EPOCHS;
  if (nextBoundary > MAX_EPOCH_NUMBER) {
    throw new RangeError("The next boundary exceeds the supported CKB epoch range.");
  }
  const preparationStart = nextBoundary - preparationBuffer;
  const remainingEpochs = nextBoundary - currentEpoch;

  return Object.freeze({
    cycleNumber,
    estimatedTime: formatEstimatedTime(remainingEpochs),
    nextBoundary,
    preparationStart,
    remainingEpochs,
    windowOpen: currentEpoch >= preparationStart,
  });
}
