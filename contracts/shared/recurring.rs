use ckb_hash::new_blake2b;

const POLICY_PAYLOAD_DOMAIN: &[u8] = b"ckb-automata/policy-payload/v1";
const MAX_ABSOLUTE_BLOCK_NUMBER: u64 = (1 << 56) - 1;

pub fn recurring_payload_hash(
    policy_script_hash: &[u8; 32],
    payload: &[u8],
) -> Option<[u8; 32]> {
    let body_length = policy_script_hash
        .len()
        .checked_add(payload.len())
        .and_then(|length| u32::try_from(length).ok())?;
    let mut hasher = new_blake2b();
    hasher.update(POLICY_PAYLOAD_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&body_length.to_le_bytes());
    hasher.update(policy_script_hash);
    hasher.update(payload);
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    Some(result)
}

pub fn valid_recurring_schedule(
    amount: u64,
    interval_blocks: u64,
    first_not_before: u64,
    total_runs: u32,
    final_refund_kind: u8,
) -> bool {
    amount > 0
        && interval_blocks > 0
        && first_not_before > 0
        && first_not_before <= MAX_ABSOLUTE_BLOCK_NUMBER
        && total_runs > 0
        && final_refund_kind == 0
}
