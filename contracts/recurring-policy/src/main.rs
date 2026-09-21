#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type_hash,
        load_input_since, load_script, load_script_hash, load_witness_args,
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
mod recurring_generated {
    include!("../../generated/recurring_v1.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

mod recurring {
    include!("../../shared/recurring.rs");
}

use error_codes::ScriptError;
use job_generated::JobDataV1;
use recurring_generated::RecurringPayloadV1;

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
        (1, 1) => validate_execution(),
        _ => Err(ScriptError::InvalidApplicationState),
    }
}

fn validate_creation() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
    let witness =
        load_witness_args(0, Source::Input).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let payload_bytes = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    let payload = validate_intent(&job, &payload_bytes)?;
    if read_u64(job.sequence().as_slice()) != 0
        || read_u64(job.not_before().as_slice()) != read_u64(payload.first_not_before().as_slice())
        || read_u32(job.remaining_runs().as_slice()) != read_u32(payload.total_runs().as_slice())
    {
        return Err(ScriptError::InvalidData);
    }
    Ok(())
}

fn validate_execution() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let payload_bytes = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    let payload = validate_intent(&job, &payload_bytes)?;

    if read_u32(job.remaining_runs().as_slice()) <= 1 {
        return Err(ScriptError::InvalidApplicationState);
    }
    let committed_since = read_u64(job.not_before().as_slice());
    let actual_since =
        load_input_since(0, Source::GroupInput).map_err(|_| ScriptError::InvalidSince)?;
    if actual_since != committed_since {
        return Err(ScriptError::InvalidSince);
    }

    let mut recipient_hash = [0_u8; 32];
    recipient_hash.copy_from_slice(payload.recipient_lock_hash().as_slice());
    let amount = read_u64(payload.amount().as_slice());
    let mut payout_count = 0;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == recipient_hash {
            payout_count += 1;
            let capacity = load_cell_capacity(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let type_hash = load_cell_type_hash(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let data = load_cell_data(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            if capacity != amount || type_hash.is_some() || !data.is_empty() {
                return Err(ScriptError::InvalidApplicationState);
            }
        }
    }
    if payout_count != 1 {
        return Err(ScriptError::InvalidApplicationState);
    }
    let successor_data =
        load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let successor = JobDataV1::from_slice(&successor_data).map_err(|_| ScriptError::InvalidData)?;
    let successor_sequence = read_u64(job.sequence().as_slice())
        .checked_add(1)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let expected_successor = recurring::scheduled_block_lower_bound(
        read_u64(payload.first_not_before().as_slice()),
        successor_sequence,
        read_u64(payload.interval_blocks().as_slice()),
    )
    .ok_or(ScriptError::ArithmeticOverflow)?;
    if read_u64(successor.sequence().as_slice()) != successor_sequence
        || read_u64(successor.not_before().as_slice()) != expected_successor
        || successor.trigger_params_hash().as_slice()
            != recurring::absolute_block_trigger_hash(expected_successor)
    {
        return Err(ScriptError::TriggerHashMismatch);
    }
    Ok(())
}

fn validate_intent(
    job: &JobDataV1,
    payload_bytes: &[u8],
) -> Result<RecurringPayloadV1, ScriptError> {
    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    if !script.args().raw_data().is_empty() {
        return Err(ScriptError::InvalidData);
    }
    let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if job.policy_script_hash().as_slice() != script_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }
    if read_u16(job.version().as_slice()) != 1
        || read_u16(job.flags().as_slice()) != 0
        || job.state().as_slice() != [0]
        || read_u16(job.trigger_kind().as_slice()) != 1
        || read_u64(job.not_after().as_slice()) != 0
    {
        return Err(ScriptError::InvalidData);
    }
    let expected_payload = recurring::recurring_payload_hash(&script_hash, payload_bytes)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if job.payload_hash().as_slice() != expected_payload {
        return Err(ScriptError::PayloadHashMismatch);
    }
    let payload =
        RecurringPayloadV1::from_slice(payload_bytes).map_err(|_| ScriptError::InvalidData)?;
    let amount = read_u64(payload.amount().as_slice());
    let interval = read_u64(payload.interval_blocks().as_slice());
    let first = read_u64(payload.first_not_before().as_slice());
    let total_runs = read_u32(payload.total_runs().as_slice());
    if read_u16(payload.version().as_slice()) != 1
        || is_zero(payload.owner_lock_hash().as_slice())
        || is_zero(payload.recipient_lock_hash().as_slice())
        || !recurring::valid_recurring_schedule(
            amount,
            interval,
            first,
            total_runs,
            payload.final_refund_kind().as_slice()[0],
        )
        || payload.owner_lock_hash().as_slice() != job.cancel_lock_hash().as_slice()
        || payload.reward().as_slice() != job.reward().as_slice()
    {
        return Err(ScriptError::InvalidData);
    }
    let sequence = read_u64(job.sequence().as_slice());
    let remaining_runs = read_u32(job.remaining_runs().as_slice());
    if sequence
        .checked_add(remaining_runs as u64)
        .ok_or(ScriptError::ArithmeticOverflow)?
        != total_runs as u64
    {
        return Err(ScriptError::InvalidData);
    }
    let expected_lower_bound = recurring::scheduled_block_lower_bound(first, sequence, interval)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if read_u64(job.not_before().as_slice()) != expected_lower_bound
        || job.trigger_params_hash().as_slice()
            != recurring::absolute_block_trigger_hash(expected_lower_bound)
    {
        return Err(ScriptError::TriggerHashMismatch);
    }
    Ok(payload)
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
