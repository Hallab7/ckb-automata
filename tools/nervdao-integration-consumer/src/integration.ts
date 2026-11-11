import {
  assertNervDaoTestnetIdentity,
  nervDaoOwnerAction,
  type NervDaoChainIdentity,
} from "@ckb-automata/nervdao-integration";

export function reviewOwnerAction(input: {
  readonly reviewed: NervDaoChainIdentity;
  readonly expected: NervDaoChainIdentity;
  readonly signerGenesis: string;
  readonly state: "deposited" | "withdrawing";
  readonly hasPrepareAccumulator: boolean;
}) {
  assertNervDaoTestnetIdentity(input.reviewed, input.signerGenesis, input.expected);
  return nervDaoOwnerAction(input.state, input.hasPrepareAccumulator);
}
