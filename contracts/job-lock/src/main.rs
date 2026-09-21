#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type_hash,
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
mod generated {
    include!("../../generated/job_v1.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

use error_codes::ScriptError;
use generated::JobDataV1;

entry!(main);
default_alloc!();

const MODE_CANCEL: u8 = 1;
const MODE_RECOVER: u8 = 2;

enum Operation {
    Execute {
        reward_output_index: usize,
        executor_lock_hash: [u8; 32],
    },
    Cancel,
    Recover,
}

fn main() -> i8 {
    match program_entry() {
        Ok(()) => 0,
        Err(error) => error.into(),
    }
}

fn program_entry() -> Result<(), ScriptError> {
    match load_operation()? {
        Operation::Execute {
            reward_output_index,
            executor_lock_hash,
        } => validate_execution(reward_output_index, executor_lock_hash),
        Operation::Cancel | Operation::Recover => validate_owner_exit(),
    }
}

fn load_operation() -> Result<Operation, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let input_type = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?;
    let bytes = input_type.raw_data();
    match bytes.as_ref() {
        [MODE_CANCEL] => Ok(Operation::Cancel),
        [MODE_RECOVER] => Ok(Operation::Recover),
        execution if execution.len() == 37 && execution[0] == 0 => {
            let mut output_index = [0_u8; 4];
            output_index.copy_from_slice(&execution[1..5]);
            let mut executor_lock_hash = [0_u8; 32];
            executor_lock_hash.copy_from_slice(&execution[5..37]);
            Ok(Operation::Execute {
                reward_output_index: u32::from_le_bytes(output_index) as usize,
                executor_lock_hash,
            })
        }
        _ => Err(ScriptError::InvalidWitnessMode),
    }
}

fn load_job() -> Result<JobDataV1, ScriptError> {
    if QueryIter::new(load_cell_capacity, Source::GroupInput).count() != 1 {
        return Err(ScriptError::InvalidData);
    }
    let data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)
}

fn validate_owner_exit() -> Result<(), ScriptError> {
    let job = load_job()?;
    let mut cancel_lock_hash = [0_u8; 32];
    cancel_lock_hash.copy_from_slice(job.cancel_lock_hash().as_slice());

    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if cancel_lock_hash == job_lock_hash
        || !QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|lock_hash| lock_hash == cancel_lock_hash && lock_hash != job_lock_hash)
    {
        return Err(ScriptError::MissingOwnerAuthorization);
    }

    validate_refund(cancel_lock_hash)
}

fn validate_execution(
    reward_output_index: usize,
    executor_lock_hash: [u8; 32],
) -> Result<(), ScriptError> {
    let job = load_job()?;
    let mut committed_policy_hash = [0_u8; 32];
    committed_policy_hash.copy_from_slice(job.policy_script_hash().as_slice());
    let actual_policy_hash = load_cell_type_hash(0, Source::GroupInput)
        .map_err(|_| ScriptError::PolicyHashMismatch)?
        .ok_or(ScriptError::PolicyHashMismatch)?;
    if actual_policy_hash != committed_policy_hash {
        return Err(ScriptError::PolicyHashMismatch);
    }

    let job_lock_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if executor_lock_hash == job_lock_hash
        || !QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|lock_hash| lock_hash == executor_lock_hash && lock_hash != job_lock_hash)
    {
        return Err(ScriptError::RewardRecipientMismatch);
    }

    let mut reward_bytes = [0_u8; 8];
    reward_bytes.copy_from_slice(job.reward().as_slice());
    let expected_reward = u64::from_le_bytes(reward_bytes);
    let actual_reward = load_cell_capacity(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardAmountMismatch)?;
    if actual_reward != expected_reward {
        return Err(ScriptError::RewardAmountMismatch);
    }

    let actual_recipient = load_cell_lock_hash(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    let reward_type = load_cell_type_hash(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    let reward_data = load_cell_data(reward_output_index, Source::Output)
        .map_err(|_| ScriptError::RewardRecipientMismatch)?;
    if actual_recipient != executor_lock_hash || reward_type.is_some() || !reward_data.is_empty() {
        return Err(ScriptError::RewardRecipientMismatch);
    }
    Ok(())
}

fn validate_refund(cancel_lock_hash: [u8; 32]) -> Result<(), ScriptError> {
    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let refund_capacity =
        load_cell_capacity(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;
    let refund_lock_hash =
        load_cell_lock_hash(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;
    let refund_type_hash =
        load_cell_type_hash(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;
    let refund_data =
        load_cell_data(0, Source::Output).map_err(|_| ScriptError::CapacityNotConserved)?;

    if refund_capacity != input_capacity
        || refund_lock_hash != cancel_lock_hash
        || refund_type_hash.is_some()
        || !refund_data.is_empty()
    {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
}
