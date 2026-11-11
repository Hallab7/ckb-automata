# DAO Harvest V3 independent recovery

The V3 recovery command builds unsigned owner transactions from a versioned deployment manifest and
a public CKB RPC. It does not read a private key or contact the CKAutomata API, database, Redis, or
executors. Sign and broadcast the exported transaction with the wallet that controls the owner lock.

The manifest must use schema `ckb-automata/dao-harvest-deployment/v3` and must identify CKB testnet,
its genesis block, every V3 code cell, the Nervos DAO dependency, and the secp256k1 dependency. The
command rejects another network, a stale input, a non-canonical header, an immature claim, or an
owner lock that differs from the payload commitment.

## Start withdrawal

```powershell
pnpm recovery:harvest:v3 owner-exit `
  --manifest deploy/manifests/dao-harvest-v3-testnet.json `
  --rpc-url https://testnet.ckb.dev `
  --owner-lock owner-lock.json `
  --job TX_HASH:INDEX `
  --vault TX_HASH:INDEX `
  --compensation TX_HASH:INDEX `
  --identity TX_HASH:INDEX `
  --payload 0x... `
  --progress 0x... `
  --deposit-header 0x... `
  --fee 100000 `
  --output owner-exit-unsigned.json
```

The export keeps the owner-locked withdrawing DAO output at the vault input's exact transaction
index. Funds remain subject to normal Nervos DAO maturity after this transaction is committed.

## Claim after maturity

```powershell
pnpm recovery:harvest:v3 owner-recovery `
  --manifest deploy/manifests/dao-harvest-v3-testnet.json `
  --rpc-url https://testnet.ckb.dev `
  --owner-lock owner-lock.json `
  --job TX_HASH:INDEX `
  --vault TX_HASH:INDEX `
  --compensation TX_HASH:INDEX `
  --identity TX_HASH:INDEX `
  --prepare-accumulator TX_HASH:INDEX `
  --payload 0x... `
  --progress 0x... `
  --credit 0x... `
  --deposit-header 0x... `
  --prepare-header 0x... `
  --claim-since DECIMAL_SINCE `
  --vault-occupied-capacity SHANNONS `
  --fee 100000 `
  --output owner-recovery-unsigned.json
```

The exported artifact records the intent hash, exact reviewed transaction, value accounting,
deployment identity, canonical headers, and owner signing entry. It contains no secret material.
