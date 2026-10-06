#![no_main]
#![no_std]

use alloc::vec::Vec;
use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash,
        load_cell_occupied_capacity, load_cell_type_hash, load_header, load_script,
        load_script_hash, load_witness_args,
    },
};
use molecule::prelude::Entity;

#[allow(
    dead_code,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
mod job_generated {
    include!("../../generated/job_v1.rs");
}

#[allow(
    dead_code,
    clippy::clone_on_copy,
    clippy::derivable_impls,
    clippy::if_same_then_else,
    clippy::manual_is_multiple_of,
    clippy::needless_borrow,
    clippy::write_literal
)]
mod harvest_generated {
    include!("../../generated/dao_harvest_v1.rs");
}

#[allow(dead_code)]
mod dao_harvest {
    include!("../../shared/dao_harvest.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

mod execution_witness {
    include!("../../shared/execution_witness.rs");
}

#[allow(dead_code)]
mod trigger {
    include!("../../shared/trigger.rs");
}

use error_codes::ScriptError;
use harvest_generated::DaoHarvestPayloadV1;
use job_generated::JobDataV1;

entry!(main);
default_alloc!();

fn main() -> i8 {
    match program_entry() {
        Ok(()) => 0,
        Err(error) => error.into(),
    }
}

fn program_entry() -> Result<(), ScriptError> {
    let input_count = QueryIter::new(load_cell_capacity, Source::GroupInput).count();
    let output_count = QueryIter::new(load_cell_capacity, Source::GroupOutput).count();
    match (input_count, output_count) {
        (0, 1) => validate_creation(),
        (1, 0 | 1) => validate_spend(),
        _ => Err(ScriptError::InvalidApplicationState),
    }
}

fn validate_creation() -> Result<(), ScriptError> {
    let job_data = load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::InvalidData)?;
    let (payload, proof) = load_payload_envelope(0, Source::Input)?;
    validate_intent(&job, &payload)?;
    validate_reward_budget(&job, Source::GroupOutput)?;
    validate_executor_proof(&payload, &proof, None)?;
    if read_u64(job.sequence().as_slice()) != 0
        || read_u32(job.remaining_runs().as_slice())
            != read_u32(payload.total_cycles().as_slice())
                .checked_mul(2)
                .ok_or(ScriptError::ArithmeticOverflow)?
    {
        return Err(ScriptError::CycleLimitReached);
    }
    let (_, output_index) = unique_vault_cell(&payload, Source::Output)?;
    validate_vault_binding(&job, &payload, output_index, Source::Output)?;
    validate_dao_cell(&payload, output_index, Source::Output, false)
}

fn validate_spend() -> Result<(), ScriptError> {
    let job_data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::InvalidData)?;
    let (payload, proof) = load_payload_envelope(0, Source::GroupInput)?;
    validate_intent(&job, &payload)?;
    validate_reward_budget(&job, Source::GroupInput)?;

    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let input_type = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?
        .raw_data();
    match execution_witness::parse_witness_operation(&input_type) {
        Some(execution_witness::WitnessOperation::Execute(request)) => {
            let sequence = read_u64(job.sequence().as_slice());
            if sequence.is_multiple_of(2) {
                validate_executor_proof(&payload, &proof, Some(request.executor_lock_hash))?;
                validate_prepare(&job, &payload)
            } else {
                if !proof.is_empty() {
                    return Err(ScriptError::InvalidExecutorSet);
                }
                validate_roll(&job, &payload)
            }
        }
        Some(
            execution_witness::WitnessOperation::Cancel
            | execution_witness::WitnessOperation::Recover,
        ) => {
            if !proof.is_empty() {
                return Err(ScriptError::InvalidExecutorSet);
            }
            validate_owner(&payload)
        }
        _ => Err(ScriptError::InvalidWitnessMode),
    }
}

fn load_payload_envelope(
    index: usize,
    source: Source,
) -> Result<(DaoHarvestPayloadV1, Vec<[u8; 32]>), ScriptError> {
    let witness = load_witness_args(index, source).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let envelope = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    if envelope.len() < 4 {
        return Err(ScriptError::PayloadHashMismatch);
    }
    let payload_size = read_u32(&envelope[..4]) as usize;
    if payload_size < 4 || payload_size > envelope.len() {
        return Err(ScriptError::PayloadHashMismatch);
    }
    let payload = DaoHarvestPayloadV1::from_slice(&envelope[..payload_size])
        .map_err(|_| ScriptError::InvalidData)?;
    let proof_bytes = &envelope[payload_size..];
    if proof_bytes.is_empty() {
        return Ok((payload, Vec::new()));
    }
    let count = proof_bytes[0] as usize;
    if count == 0 || proof_bytes.len() != 1 + count * 32 {
        return Err(ScriptError::InvalidExecutorSet);
    }
    let mut proof = Vec::with_capacity(count);
    for chunk in proof_bytes[1..].chunks_exact(32) {
        proof.push(
            chunk
                .try_into()
                .map_err(|_| ScriptError::InvalidExecutorSet)?,
        );
    }
    Ok((payload, proof))
}

fn validate_intent(job: &JobDataV1, payload: &DaoHarvestPayloadV1) -> Result<(), ScriptError> {
    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    if !script.args().raw_data().is_empty() {
        return Err(ScriptError::InvalidData);
    }
    let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if job.policy_script_hash().as_slice() != script_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }
    let expected_hash = dao_harvest::dao_harvest_payload_hash(&script_hash, payload.as_slice())
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if job.payload_hash().as_slice() != expected_hash {
        return Err(ScriptError::PayloadHashMismatch);
    }

    let total_actions = read_u32(payload.total_cycles().as_slice())
        .checked_mul(2)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let sequence = read_u64(job.sequence().as_slice());
    let remaining = read_u32(job.remaining_runs().as_slice());
    let valid_progress = sequence
        .checked_add(remaining as u64)
        .is_some_and(|value| value == total_actions as u64);
    let buffer = read_u64(payload.prepare_buffer_epochs().as_slice());
    let margin = read_u64(payload.confirmation_margin_epochs().as_slice());
    let not_before = read_u64(job.not_before().as_slice());
    let not_after = read_u64(job.not_after().as_slice());
    let absolute_epoch = |value| {
        matches!(
            trigger::decode_absolute_since(value),
            Some((trigger::SinceMetric::Epoch { .. }, _))
        )
    };
    if read_u16(job.version().as_slice()) != 1
        || read_u16(job.flags().as_slice()) != 0
        || job.state().as_slice() != [0]
        || read_u16(job.trigger_kind().as_slice()) != 2
        || read_u16(payload.version().as_slice()) != dao_harvest::DAO_HARVEST_PAYLOAD_VERSION
        || is_zero(payload.owner_lock_hash().as_slice())
        || is_zero(payload.payout_lock_hash().as_slice())
        || is_zero(payload.vault_lock_hash().as_slice())
        || is_zero(payload.dao_type_hash().as_slice())
        || payload.owner_lock_hash().as_slice() == payload.vault_lock_hash().as_slice()
        || payload.payout_lock_hash().as_slice() == payload.vault_lock_hash().as_slice()
        || read_u64(payload.principal_capacity().as_slice()) == 0
        || read_u64(payload.executor_reward().as_slice()) == 0
        || read_u32(payload.total_cycles().as_slice()) == 0
        || dao_harvest::decode_relative_epoch_duration(margin).is_none()
        || dao_harvest::decode_relative_epoch_duration(buffer).is_none()
        || !relative_epoch_strictly_greater(buffer, margin)
        || !absolute_epoch(not_before)
        || (not_after != 0
            && (!absolute_epoch(not_after)
                || trigger::absolute_since_strictly_advances(not_after, not_before)))
        || payload.owner_lock_hash().as_slice() != job.cancel_lock_hash().as_slice()
        || payload.executor_reward().as_slice() != job.reward().as_slice()
        || payload.end_epoch_since().as_slice() != job.not_after().as_slice()
        || !valid_progress
    {
        return Err(ScriptError::InvalidData);
    }
    Ok(())
}

fn relative_epoch_strictly_greater(left: u64, right: u64) -> bool {
    let Some((left_number, left_index, left_length)) =
        dao_harvest::decode_relative_epoch_duration(left)
    else {
        return false;
    };
    let Some((right_number, right_index, right_length)) =
        dao_harvest::decode_relative_epoch_duration(right)
    else {
        return false;
    };
    let left_length = if left_length == 0 { 1 } else { left_length };
    let right_length = if right_length == 0 { 1 } else { right_length };
    left_number > right_number
        || (left_number == right_number && left_index * right_length > right_index * left_length)
}

fn validate_executor_proof(
    payload: &DaoHarvestPayloadV1,
    proof: &[[u8; 32]],
    executor: Option<[u8; 32]>,
) -> Result<(), ScriptError> {
    if proof.is_empty()
        || proof.len() > dao_harvest::MAX_PREPARE_EXECUTORS
        || proof.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(ScriptError::InvalidExecutorSet);
    }
    let mut canonical = proof.to_vec();
    let hash = dao_harvest::prepare_executor_set_hash(&mut canonical)
        .map_err(|_| ScriptError::InvalidExecutorSet)?;
    if payload.prepare_executor_set_hash().as_slice() != hash {
        return Err(ScriptError::InvalidExecutorSet);
    }
    if executor.is_some_and(|identity| proof.binary_search(&identity).is_err()) {
        return Err(ScriptError::UnauthorizedExecutor);
    }
    Ok(())
}

fn validate_reward_budget(job: &JobDataV1, source: Source) -> Result<(), ScriptError> {
    let reward = read_u64(job.reward().as_slice());
    let remaining_runs = read_u32(job.remaining_runs().as_slice());
    let expected_budget = reward
        .checked_mul(remaining_runs as u64)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if read_u64(job.remaining_budget().as_slice()) != expected_budget {
        return Err(ScriptError::CapacityNotConserved);
    }
    let capacity = load_cell_capacity(0, source).map_err(|_| ScriptError::CapacityNotConserved)?;
    let occupied =
        load_cell_occupied_capacity(0, source).map_err(|_| ScriptError::CapacityNotConserved)?;
    if capacity
        .checked_sub(occupied)
        .is_none_or(|spendable| spendable < expected_budget)
    {
        return Err(ScriptError::CapacityNotConserved);
    }

    if source == Source::GroupInput && remaining_runs > 1 {
        let successor_data = load_cell_data(0, Source::GroupOutput)
            .map_err(|_| ScriptError::CapacityNotConserved)?;
        let successor =
            JobDataV1::from_slice(&successor_data).map_err(|_| ScriptError::InvalidData)?;
        if read_u64(successor.remaining_budget().as_slice())
            != expected_budget
                .checked_sub(reward)
                .ok_or(ScriptError::ArithmeticOverflow)?
        {
            return Err(ScriptError::CapacityNotConserved);
        }
    }
    Ok(())
}

fn validate_prepare(job: &JobDataV1, payload: &DaoHarvestPayloadV1) -> Result<(), ScriptError> {
    let (_, input_index) = unique_vault_cell(payload, Source::Input)?;
    let (_, output_index) = unique_vault_cell(payload, Source::Output)?;
    validate_vault_binding(job, payload, input_index, Source::Input)?;
    validate_dao_cell(payload, input_index, Source::Input, false)?;
    validate_dao_cell(payload, output_index, Source::Output, true)?;
    validate_same_vault_transition(input_index, output_index)
}

fn validate_roll(job: &JobDataV1, payload: &DaoHarvestPayloadV1) -> Result<(), ScriptError> {
    let (_, input_index) = unique_vault_cell(payload, Source::Input)?;
    let (_, output_index) = unique_vault_cell(payload, Source::Output)?;
    validate_vault_binding(job, payload, input_index, Source::Input)?;
    validate_dao_cell(payload, input_index, Source::Input, true)?;
    validate_dao_cell(payload, output_index, Source::Output, false)?;
    validate_same_vault_transition(input_index, output_index)?;

    let maximum = load_maximum_withdraw(input_index)?;
    let principal = read_u64(payload.principal_capacity().as_slice());
    let compensation = maximum
        .checked_sub(principal)
        .ok_or(ScriptError::PrincipalMismatch)?;
    if compensation < read_u64(payload.min_compensation().as_slice()) {
        return Err(ScriptError::CompensationBelowMinimum);
    }
    validate_exact_payout(payload, compensation)
}

fn unique_vault_cell(
    payload: &DaoHarvestPayloadV1,
    source: Source,
) -> Result<([u8; 32], usize), ScriptError> {
    let expected: [u8; 32] = payload
        .vault_lock_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::InvalidDaoCell)?;
    let mut found = None;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, source).enumerate() {
        if lock_hash == expected {
            if found.is_some() {
                return Err(ScriptError::InvalidDaoCell);
            }
            found = Some(index);
        }
    }
    found
        .map(|index| (expected, index))
        .ok_or(ScriptError::InvalidDaoCell)
}

fn validate_vault_binding(
    job: &JobDataV1,
    payload: &DaoHarvestPayloadV1,
    vault_index: usize,
    vault_source: Source,
) -> Result<(), ScriptError> {
    let vault_lock =
        load_cell_lock(vault_index, vault_source).map_err(|_| ScriptError::InvalidDaoCell)?;
    let args = vault_lock.args().raw_data();
    if args.len() != 128
        || &args[..32] != job.job_id().as_slice()
        || &args[32..64] != payload.owner_lock_hash().as_slice()
    {
        return Err(ScriptError::InvalidDaoCell);
    }
    let job_lock_source = match vault_source {
        Source::Input => Source::GroupInput,
        Source::Output => Source::GroupOutput,
        _ => return Err(ScriptError::InvalidDaoCell),
    };
    let job_lock_hash =
        load_cell_lock_hash(0, job_lock_source).map_err(|_| ScriptError::MissingBoundJob)?;
    let policy_hash = load_script_hash().map_err(|_| ScriptError::PolicyHashMismatch)?;
    if &args[64..96] != job_lock_hash.as_slice() || &args[96..128] != policy_hash.as_slice() {
        return Err(ScriptError::MissingBoundJob);
    }
    Ok(())
}

fn validate_dao_cell(
    payload: &DaoHarvestPayloadV1,
    index: usize,
    source: Source,
    withdrawing: bool,
) -> Result<(), ScriptError> {
    let capacity = load_cell_capacity(index, source).map_err(|_| ScriptError::InvalidDaoCell)?;
    let data = load_cell_data(index, source).map_err(|_| ScriptError::InvalidDaoCell)?;
    let type_hash = load_cell_type_hash(index, source)
        .map_err(|_| ScriptError::InvalidDaoCell)?
        .ok_or(ScriptError::InvalidDaoCell)?;
    if capacity != read_u64(payload.principal_capacity().as_slice()) {
        return Err(ScriptError::PrincipalMismatch);
    }
    if type_hash.as_slice() != payload.dao_type_hash().as_slice()
        || dao_harvest::is_withdrawing_dao_data(&data) != Some(withdrawing)
    {
        return Err(ScriptError::InvalidDaoCell);
    }
    Ok(())
}

fn validate_same_vault_transition(
    input_index: usize,
    output_index: usize,
) -> Result<(), ScriptError> {
    let input_lock =
        load_cell_lock_hash(input_index, Source::Input).map_err(|_| ScriptError::InvalidDaoCell)?;
    let output_lock = load_cell_lock_hash(output_index, Source::Output)
        .map_err(|_| ScriptError::InvalidDaoCell)?;
    let input_type =
        load_cell_type_hash(input_index, Source::Input).map_err(|_| ScriptError::InvalidDaoCell)?;
    let output_type = load_cell_type_hash(output_index, Source::Output)
        .map_err(|_| ScriptError::InvalidDaoCell)?;
    if input_lock != output_lock || input_type != output_type {
        return Err(ScriptError::InvalidDaoCell);
    }
    Ok(())
}

fn load_maximum_withdraw(input_index: usize) -> Result<u64, ScriptError> {
    let witness =
        load_witness_args(input_index, Source::Input).map_err(|_| ScriptError::MissingHeader)?;
    let input_type = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::MissingHeader)?
        .raw_data();
    if input_type.len() != 8 {
        return Err(ScriptError::MissingHeader);
    }
    let deposit_header_index = read_u64(&input_type) as usize;
    let deposit_header = load_header(deposit_header_index, Source::HeaderDep)
        .map_err(|_| ScriptError::MissingHeader)?;
    let withdrawing_header =
        load_header(input_index, Source::Input).map_err(|_| ScriptError::MissingHeader)?;
    let deposit_dao = deposit_header.raw().dao().raw_data();
    let withdrawing_dao = withdrawing_header.raw().dao().raw_data();
    if deposit_dao.len() != 32 || withdrawing_dao.len() != 32 {
        return Err(ScriptError::MissingHeader);
    }
    let deposit_rate = read_u64(&deposit_dao[8..16]);
    let withdrawing_rate = read_u64(&withdrawing_dao[8..16]);
    let principal =
        load_cell_capacity(input_index, Source::Input).map_err(|_| ScriptError::InvalidDaoCell)?;
    let occupied = load_cell_occupied_capacity(input_index, Source::Input)
        .map_err(|_| ScriptError::InvalidDaoCell)?;
    dao_harvest::maximum_withdraw_capacity(principal, occupied, deposit_rate, withdrawing_rate)
        .ok_or(ScriptError::ArithmeticOverflow)
}

fn validate_exact_payout(
    payload: &DaoHarvestPayloadV1,
    compensation: u64,
) -> Result<(), ScriptError> {
    let expected: [u8; 32] = payload
        .payout_lock_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::PayoutMismatch)?;
    let owner: [u8; 32] = payload
        .owner_lock_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::PayoutMismatch)?;
    let payout_is_owner = expected == owner;
    let mut exact_matches = 0;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == expected {
            let capacity = load_cell_capacity(index, Source::Output)
                .map_err(|_| ScriptError::PayoutMismatch)?;
            let type_hash = load_cell_type_hash(index, Source::Output)
                .map_err(|_| ScriptError::PayoutMismatch)?;
            let data =
                load_cell_data(index, Source::Output).map_err(|_| ScriptError::PayoutMismatch)?;
            if type_hash.is_some() || !data.is_empty() {
                return Err(ScriptError::PayoutMismatch);
            }
            if capacity == compensation {
                exact_matches += 1;
            } else if !payout_is_owner {
                return Err(ScriptError::PayoutMismatch);
            }
        }
    }
    if (payout_is_owner && exact_matches >= 1) || (!payout_is_owner && exact_matches == 1) {
        Ok(())
    } else {
        Err(ScriptError::PayoutMismatch)
    }
}

fn validate_owner(payload: &DaoHarvestPayloadV1) -> Result<(), ScriptError> {
    let owner: [u8; 32] = payload
        .owner_lock_hash()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::MissingOwnerAuthorization)?;
    if QueryIter::new(load_cell_lock_hash, Source::Input).any(|lock_hash| lock_hash == owner) {
        Ok(())
    } else {
        Err(ScriptError::MissingOwnerAuthorization)
    }
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes.try_into().expect("Molecule Uint16"))
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("Molecule Uint32"))
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("Molecule Uint64"))
}

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|byte| *byte == 0)
}
