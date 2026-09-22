#!/bin/sh
set -eu

readonly CKB_HOME=/var/lib/ckb
readonly FIXTURE_LOCK_ARG=0xb6ac779881b4fe05a167e413ff534469b6b5f6c0
readonly GENESIS_MESSAGE=ckb-automata-local-v1

if [ ! -f "$CKB_HOME/ckb.toml" ]; then
  ckb init \
    -C "$CKB_HOME" \
    --chain dev \
    --force \
    --genesis-message "$GENESIS_MESSAGE" \
    --rpc-port 8114 \
    --p2p-port 8115 \
    --ba-arg "$FIXTURE_LOCK_ARG"

  sed -i \
    "/random generated private key/,+4 s/lock.args = \"0x[0-9a-f]*\"/lock.args = \"$FIXTURE_LOCK_ARG\"/" \
    "$CKB_HOME/specs/dev.toml"
fi

fixture_count=$(grep -c "lock.args = \"$FIXTURE_LOCK_ARG\"" "$CKB_HOME/specs/dev.toml")
if [ "$fixture_count" -lt 2 ]; then
  echo "The CKB data volume does not contain the expected deterministic local genesis." >&2
  echo "Remove only the ckb-automata-ckb-data-v1 volume and start the service again." >&2
  exit 1
fi

sed -i \
  -e "s/poll_interval = 1000/poll_interval = 50/" \
  -e "s/value = 5000/value = 50/" \
  "$CKB_HOME/ckb-miner.toml"

exec ckb run -C "$CKB_HOME" --indexer
