use ckb_hash::new_blake2b;

pub const DAO_HARVEST_PAYLOAD_VERSION: u16 = 1;
pub const MAX_PREPARE_EXECUTORS: usize = 8;
pub const PREPARE_OPERATION: u8 = 0;
pub const ROLL_OPERATION: u8 = 1;
pub const OWNER_STOP_OPERATION: u8 = 2;
pub const OWNER_EXIT_OPERATION: u8 = 3;
pub const OWNER_RECOVER_OPERATION: u8 = 4;

const POLICY_PAYLOAD_DOMAIN: &[u8] = b"ckb-automata/policy-payload/v1";
const EXECUTOR_SET_DOMAIN: &[u8] = b"ckb-automata/dao-harvest-executors/v1";
const RELATIVE_FLAG: u64 = 1 << 63;
const EPOCH_METRIC: u64 = 0b01 << 61;
const RESERVED_MASK: u64 = 0b1_1111 << 56;
const VALUE_MASK: u64 = (1 << 56) - 1;

fn domain_hash(domain: &[u8], body_parts: &[&[u8]]) -> Option<[u8; 32]> {
    let body_length = body_parts.iter().try_fold(0_usize, |total, part| {
        total.checked_add(part.len())
    })?;
    let body_length = u32::try_from(body_length).ok()?;
    let mut hasher = new_blake2b();
    hasher.update(domain);
    hasher.update(&[0]);
    hasher.update(&body_length.to_le_bytes());
    for part in body_parts {
        hasher.update(part);
    }
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    Some(result)
}

pub fn dao_harvest_payload_hash(
    policy_script_hash: &[u8; 32],
    payload: &[u8],
) -> Option<[u8; 32]> {
    domain_hash(POLICY_PAYLOAD_DOMAIN, &[policy_script_hash, payload])
}

pub fn canonical_executor_set(
    executor_lock_hashes: &mut [[u8; 32]],
) -> Result<(), ExecutorSetError> {
    if executor_lock_hashes.is_empty() || executor_lock_hashes.len() > MAX_PREPARE_EXECUTORS {
        return Err(ExecutorSetError::InvalidCount);
    }
    executor_lock_hashes.sort_unstable();
    if executor_lock_hashes.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(ExecutorSetError::Duplicate);
    }
    Ok(())
}

pub fn prepare_executor_set_hash(
    executor_lock_hashes: &mut [[u8; 32]],
) -> Result<[u8; 32], ExecutorSetError> {
    canonical_executor_set(executor_lock_hashes)?;
    let count = u32::try_from(executor_lock_hashes.len())
        .map_err(|_| ExecutorSetError::InvalidCount)?;
    let body_length = count
        .checked_mul(32)
        .and_then(|length| length.checked_add(4))
        .ok_or(ExecutorSetError::InvalidCount)?;
    let mut hasher = new_blake2b();
    hasher.update(EXECUTOR_SET_DOMAIN);
    hasher.update(&[0]);
    hasher.update(&body_length.to_le_bytes());
    hasher.update(&count.to_le_bytes());
    for identity in executor_lock_hashes {
        hasher.update(identity);
    }
    let mut result = [0_u8; 32];
    hasher.finalize(&mut result);
    Ok(result)
}

pub fn is_withdrawing_dao_data(data: &[u8]) -> Option<bool> {
    (data.len() == 8).then(|| data.iter().any(|byte| *byte != 0))
}

pub fn maximum_withdraw_capacity(
    principal_capacity: u64,
    occupied_capacity: u64,
    deposit_accumulated_rate: u64,
    withdrawing_accumulated_rate: u64,
) -> Option<u64> {
    if occupied_capacity > principal_capacity
        || deposit_accumulated_rate == 0
        || withdrawing_accumulated_rate < deposit_accumulated_rate
    {
        return None;
    }
    let counted = principal_capacity.checked_sub(occupied_capacity)?;
    let adjusted = (counted as u128)
        .checked_mul(withdrawing_accumulated_rate as u128)?
        .checked_div(deposit_accumulated_rate as u128)?;
    let adjusted = u64::try_from(adjusted).ok()?;
    occupied_capacity.checked_add(adjusted)
}

pub fn decode_relative_epoch_duration(raw: u64) -> Option<(u64, u64, u64)> {
    if raw & RELATIVE_FLAG == 0
        || raw & RESERVED_MASK != 0
        || raw & (0b11 << 61) != EPOCH_METRIC
    {
        return None;
    }
    let value = raw & VALUE_MASK;
    let number = value & 0x00ff_ffff;
    let index = (value >> 24) & 0xffff;
    let length = (value >> 40) & 0xffff;
    if number == 0 || (length == 0 && index != 0) || (length != 0 && index >= length) {
        return None;
    }
    Some((number, index, length))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutorSetError {
    InvalidCount,
    Duplicate,
}
