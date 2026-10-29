UPDATE networks
SET deployment_manifest_hash = '709b841490ad328be6e82c63f52e87607150d5c0075ca15818b4e45ef5fd0477',
    updated_at = now()
WHERE id = 'ckb_testnet'
  AND genesis_hash = '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606'
  AND deployment_manifest_hash = 'f3e4e82e77c97e9728b4b227984cc496bfb0de000d77dc8e8fe407349581c72d';
