use ckb_hash::new_blake2b;

const POLICY_PAYLOAD_DOMAIN: &[u8] = b"ckb-automata/policy-payload/v1";
const TRIGGER_PARAMS_DOMAIN: &[u8] = b"ckb-automata/trigger-params/v1";
const MAX_ABSOLUTE_BLOCK_NUMBER: u64 = (1 << 56) - 1;
const ABSOLUTE_BLOCK_TRIGGER_KIND: u16 = 1;

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

pub fn scheduled_block_lower_bound(
    first_not_before: u64,
    sequence: u64,
    interval_blocks: u64,
) -> Option<u64> {
    if first_not_before == 0 || interval_blocks == 0 {
        return None;
    }
    let offset = sequence.checked_mul(interval_blocks)?;
    let lower_bound = first_not_before.checked_add(offset)?;
    (lower_bound <= MAX_ABSOLUTE_BLOCK_NUMBER).then_some(lower_bound)
}

pub fn absolute_block_trigger_hash(not_before: u64) -> [u8; 32] {
    let body_length = 2_u32 + 8;
    let mut hasher = new_blake2b();
    hasher.update(TRIGGER_PARAMS_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&body_length.to_le_bytes());
    hasher.update(&ABSOLUTE_BLOCK_TRIGGER_KIND.to_le_bytes());
    hasher.update(&not_before.to_le_bytes());
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    result
}
