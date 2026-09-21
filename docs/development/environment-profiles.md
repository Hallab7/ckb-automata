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
