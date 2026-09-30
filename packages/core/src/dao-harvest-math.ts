import {
  createEpoch,
  parseBlockNumber,
  parseShannons,
  type BlockNumber,
  type Epoch,
  type IntegerInput,
  type Shannons,
} from "./chain-values.ts";

export const DAO_CYCLE_EPOCHS = 180n;

export interface DaoPrepareWindow {
  readonly boundary: Epoch;
  readonly startsAt: Epoch;
  readonly cutsOffAt: Epoch;
}

export interface DaoHarvestQuoteInput {
  readonly principal: IntegerInput;
  readonly occupiedCapacity: IntegerInput;
  readonly depositAccumulatedRate: IntegerInput;
  readonly projectedWithdrawAccumulatedRate: IntegerInput;
  readonly executorReward: IntegerInput;
  readonly actions: IntegerInput;
  readonly estimatedNetworkFee: IntegerInput;
  readonly snapshotBlock: IntegerInput;
  readonly validUntilBlock: IntegerInput;
  readonly currentBlock?: IntegerInput;
}

export interface DaoHarvestQuote {
  readonly principal: Shannons;
  readonly projectedMaximumWithdraw: Shannons;
  readonly projectedCompensation: Shannons;
  readonly executorReward: Shannons;
  readonly actionBudget: Shannons;
  readonly estimatedNetworkFee: Shannons;
  readonly totalRequired: Shannons;
  readonly projectedNetBenefit: bigint;
  readonly snapshotBlock: BlockNumber;
  readonly validUntilBlock: BlockNumber;
}

function denominator(epoch: Epoch): bigint {
  return epoch.length === 0n ? 1n : epoch.length;
}

function numerator(epoch: Epoch): bigint {
  return epoch.number * denominator(epoch) + epoch.index;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fromFraction(value: bigint, divisor: bigint): Epoch {
  if (value < 0n || divisor <= 0n) throw new RangeError("epoch fraction must not be negative");
  const number = value / divisor;
  const remainder = value % divisor;
  const factor = remainder === 0n ? 1n : greatestCommonDivisor(remainder, divisor);
  return createEpoch({
    number,
    index: remainder === 0n ? 0n : remainder / factor,
    length: remainder === 0n ? 0n : divisor / factor,
  });
}

export function compareEpochFractions(left: Epoch, right: Epoch): -1 | 0 | 1 {
  const comparison = numerator(left) * denominator(right) - numerator(right) * denominator(left);
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

export function addEpochs(epoch: Epoch, wholeEpochs: IntegerInput): Epoch {
  const amount = BigInt(wholeEpochs);
  if (amount < 0n) throw new RangeError("epoch duration must not be negative");
  return fromFraction(numerator(epoch) + amount * denominator(epoch), denominator(epoch));
}

export function addEpochFractions(left: Epoch, right: Epoch): Epoch {
  const divisor = denominator(left) * denominator(right);
  return fromFraction(
    numerator(left) * denominator(right) + numerator(right) * denominator(left),
    divisor,
  );
}

export function subtractEpochs(epoch: Epoch, wholeEpochs: IntegerInput): Epoch {
  const amount = BigInt(wholeEpochs);
  if (amount < 0n) throw new RangeError("epoch duration must not be negative");
  return fromFraction(numerator(epoch) - amount * denominator(epoch), denominator(epoch));
}

export function subtractEpochFractions(left: Epoch, right: Epoch): Epoch {
  const divisor = denominator(left) * denominator(right);
  return fromFraction(
    numerator(left) * denominator(right) - numerator(right) * denominator(left),
    divisor,
  );
}

export function nextDaoBoundary(deposit: Epoch, tip: Epoch): Epoch {
  if (compareEpochFractions(tip, deposit) < 0) {
    throw new RangeError("tip epoch must not be before the DAO deposit epoch");
  }
  const depositNumerator = numerator(deposit);
  const tipNumerator = numerator(tip);
  const commonDenominator = denominator(deposit) * denominator(tip);
  const depositCommon = depositNumerator * denominator(tip);
  const tipCommon = tipNumerator * denominator(deposit);
  const cycle = DAO_CYCLE_EPOCHS * commonDenominator;
  const cycles = (tipCommon - depositCommon) / cycle + 1n;
  return fromFraction(depositCommon + cycles * cycle, commonDenominator);
}

export function selectDaoPrepareWindow(input: {
  readonly deposit: Epoch;
  readonly tip: Epoch;
  readonly bufferEpochs: IntegerInput;
  readonly confirmationMarginEpochs: IntegerInput;
}): DaoPrepareWindow {
  const buffer = BigInt(input.bufferEpochs);
  const margin = BigInt(input.confirmationMarginEpochs);
  if (buffer <= 0n || margin <= 0n || margin >= buffer || buffer >= DAO_CYCLE_EPOCHS) {
    throw new RangeError("prepare buffer must exceed the positive confirmation margin");
  }
  const boundary = nextDaoBoundary(input.deposit, input.tip);
  return Object.freeze({
    boundary,
    startsAt: subtractEpochs(boundary, buffer),
    cutsOffAt: subtractEpochs(boundary, margin),
  });
}

export function calculateDaoMaximumWithdraw(input: {
  readonly principal: IntegerInput;
  readonly occupiedCapacity: IntegerInput;
  readonly depositAccumulatedRate: IntegerInput;
  readonly withdrawingAccumulatedRate: IntegerInput;
}): Shannons {
  const principal = parseShannons(input.principal);
  const occupied = parseShannons(input.occupiedCapacity);
  const depositRate = BigInt(input.depositAccumulatedRate);
  const withdrawRate = BigInt(input.withdrawingAccumulatedRate);
  if (occupied > principal) throw new RangeError("principal is below occupied capacity");
  if (depositRate <= 0n || withdrawRate < depositRate) {
    throw new RangeError("DAO accumulated rates are invalid or reversed");
  }
  const maximum = occupied + ((principal - occupied) * withdrawRate) / depositRate;
  return parseShannons(maximum);
}

export function calculateDaoHarvestQuote(input: DaoHarvestQuoteInput): DaoHarvestQuote {
  const principal = parseShannons(input.principal);
  const executorReward = parseShannons(input.executorReward);
  const networkFee = parseShannons(input.estimatedNetworkFee);
  const actions = BigInt(input.actions);
  if (actions <= 0n || actions > 0xffff_ffffn) {
    throw new RangeError("quote actions must be between 1 and uint32 maximum");
  }
  const snapshotBlock = parseBlockNumber(input.snapshotBlock);
  const validUntilBlock = parseBlockNumber(input.validUntilBlock);
  if (validUntilBlock <= snapshotBlock)
    throw new RangeError("quote expiry must follow its snapshot");
  if (input.currentBlock !== undefined && parseBlockNumber(input.currentBlock) > validUntilBlock) {
    throw new RangeError("DAO harvest quote has expired");
  }
  const maximum = calculateDaoMaximumWithdraw({
    principal,
    occupiedCapacity: input.occupiedCapacity,
    depositAccumulatedRate: input.depositAccumulatedRate,
    withdrawingAccumulatedRate: input.projectedWithdrawAccumulatedRate,
  });
  const compensation = parseShannons(maximum - principal);
  const actionBudget = parseShannons(executorReward * actions);
  const totalRequired = parseShannons(principal + actionBudget + networkFee);
  return Object.freeze({
    principal,
    projectedMaximumWithdraw: maximum,
    projectedCompensation: compensation,
    executorReward,
    actionBudget,
    estimatedNetworkFee: networkFee,
    totalRequired,
    projectedNetBenefit: compensation - actionBudget - networkFee,
    snapshotBlock,
    validUntilBlock,
  });
}
