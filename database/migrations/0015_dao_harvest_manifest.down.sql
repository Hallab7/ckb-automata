UPDATE networks
SET deployment_manifest_hash = '8902af74e77e28fc10c4d73eae37a6343e788ede98cd90c7a2add2170525bf38',
    updated_at = now()
WHERE id = 'ckb_testnet'
  AND genesis_hash = '0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606'
  AND deployment_manifest_hash = 'cddc2e92468849d33e3b42d3e925515f5d61836cf0b4625ac94d43235fe3aa66';
