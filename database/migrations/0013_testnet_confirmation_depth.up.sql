UPDATE networks
SET confirmation_depth = 5,
    updated_at = now()
WHERE id = 'ckb_testnet'
  AND confirmation_depth = 24;
