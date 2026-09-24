# Environment Profiles

Every application process must call `parseEnvironment` from
`@ckb-automata/config` before opening a listener or consuming work. The parser
requires a profile, explicit CKB network identity, genesis hash, chain
endpoints, data-service URLs, and public application origin.

| Profile           | Required CKB network | Purpose                                |
| ----------------- | -------------------- | -------------------------------------- |
| `local`           | `ckb_dev`            | Local services and a local CKB harness |
| `test`            | `ckb_dev`            | Deterministic automated tests          |
| `testnet-preview` | `ckb_testnet`        | Isolated preview deployments           |
| `testnet-public`  | `ckb_testnet`        | Stable public showcase                 |

There is no default profile or network. Missing profiles, unknown names,
cross-network combinations, and `ckb_mainnet` all fail parsing. A 32-byte
genesis hash is required even when the network label is valid; later startup
checks compare that configured hash with the connected node.

Only keys listed in `AUTOMATA_ENV_KEYS` enter the typed configuration. Other
process environment values are ignored rather than copied into logs or runtime
configuration objects.

## Local CKB deployment

`npm run infra:up` builds and starts the digest-pinned CKB dev node on
`http://127.0.0.1:58114`. The named volume has a deterministic genesis and a
public fixture wallet. Its signing key is embedded in the deployment helper by
design and must never be funded or reused outside this disposable chain.

Build clean reproducible contract artifacts, then run
`npm run contracts:deploy:local`. The command discovers the genesis system
dependencies, deploys all five binaries, mines them to commitment, and submits
a campaign-creation transaction that executes the deployed type script. It
writes the SDK target to `deploy/manifests/local.json` only after both
transactions are committed.

Set `CKB_RPC_URL` and `CKB_RPC_PORT` together when changing the host port. If
the entrypoint reports an incompatible genesis, remove only the
`ckb-automata-ckb-data-v1` Docker volume and start the local services again.

## Public CKB testnet deployment

The immutable Pudge code cells are published in
`deploy/manifests/testnet.json`. Application processes configured with
`testnet-preview` or `testnet-public` resolve that manifest by the live genesis
hash; no contract hash is copied into an application-specific configuration.

`deploy/testnet/contracts.toml` is the reproducible `ckb-cli` deployment input.
Its zero lock makes every code cell permanently immutable. Verify the committed
transaction, every code dependency, and one raw CKB-VM fixture per script with
`pnpm contracts:verify:testnet`. Set `CKB_TESTNET_RPC_URL` only to use a
different Pudge RPC endpoint for that read-only verification. The verifier and
runtime registry both require at least 24 confirmations.
