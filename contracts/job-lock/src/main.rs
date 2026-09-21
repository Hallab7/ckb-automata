#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash,
        load_cell_occupied_capacity, load_cell_type_hash, load_script_hash, load_witness_args,
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
const MAX_CONTROLLED_OUTPUTS: usize = 16;

enum Operation {
    Execute {
        controlled_output_count: usize,
        controlled_output_indices: [usize; MAX_CONTROLLED_OUTPUTS],
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
            controlled_output_count,
            controlled_output_indices,
            reward_output_index,
            executor_lock_hash,
        } => validate_execution(
            reward_output_index,
            executor_lock_hash,
            &controlled_output_indices[..controlled_output_count],
        ),
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
        execution if execution.len() >= 38 && execution[0] == 0 => {
            let mut output_index = [0_u8; 4];
            output_index.copy_from_slice(&execution[1..5]);
            let mut executor_lock_hash = [0_u8; 32];
            executor_lock_hash.copy_from_slice(&execution[5..37]);
            let controlled_output_count = execution[37] as usize;
            if controlled_output_count == 0
                || controlled_output_count > MAX_CONTROLLED_OUTPUTS
                || execution.len() != 38 + controlled_output_count * 4
            {
                return Err(ScriptError::InvalidWitnessMode);
            }
            let mut controlled_output_indices = [0_usize; MAX_CONTROLLED_OUTPUTS];
            for (position, chunk) in execution[38..].chunks_exact(4).enumerate() {
                let mut index = [0_u8; 4];
                index.copy_from_slice(chunk);
                controlled_output_indices[position] = u32::from_le_bytes(index) as usize;
            }
            let controlled = &controlled_output_indices[..controlled_output_count];
            if controlled
                .iter()
                .enumerate()
                .any(|(position, index)| controlled[..position].contains(index))
            {
                return Err(ScriptError::InvalidWitnessMode);
            }
            Ok(Operation::Execute {
                controlled_output_count,
                controlled_output_indices,
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
    controlled_output_indices: &[usize],
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
    if !controlled_output_indices.contains(&reward_output_index) {
        return Err(ScriptError::CapacityNotConserved);
    }
    validate_value_conservation(&job, controlled_output_indices)?;
    validate_one_shot_termination(&job, job_lock_hash)
}

fn validate_one_shot_termination(
    job: &JobDataV1,
    job_lock_hash: [u8; 32],
) -> Result<(), ScriptError> {
    let mut runs_bytes = [0_u8; 4];
    runs_bytes.copy_from_slice(job.remaining_runs().as_slice());
    let remaining_runs = u32::from_le_bytes(runs_bytes);
    if remaining_runs == 0 {
        return Err(ScriptError::InvalidData);
    }
    if remaining_runs == 1
        && QueryIter::new(load_cell_lock_hash, Source::Output)
            .any(|lock_hash| lock_hash == job_lock_hash)
    {
        return Err(ScriptError::SuccessorCountMismatch);
    }
    Ok(())
}

fn validate_value_conservation(
    job: &JobDataV1,
    controlled_output_indices: &[usize],
) -> Result<(), ScriptError> {
    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let occupied_capacity =
        load_cell_occupied_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let spendable_capacity = input_capacity
        .checked_sub(occupied_capacity)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    let mut budget_bytes = [0_u8; 8];
    budget_bytes.copy_from_slice(job.remaining_budget().as_slice());
    let remaining_budget = u64::from_le_bytes(budget_bytes);
    let mut reward_bytes = [0_u8; 8];
    reward_bytes.copy_from_slice(job.reward().as_slice());
    let reward = u64::from_le_bytes(reward_bytes);
    if remaining_budget > spendable_capacity || reward > remaining_budget {
        return Err(ScriptError::CapacityNotConserved);
    }

    let mut controlled_capacity = 0_u64;
    for index in controlled_output_indices {
        let capacity = load_cell_capacity(*index, Source::Output)
            .map_err(|_| ScriptError::CapacityNotConserved)?;
        let occupied = load_cell_occupied_capacity(*index, Source::Output)
            .map_err(|_| ScriptError::CapacityNotConserved)?;
        if capacity < occupied {
            return Err(ScriptError::CapacityNotConserved);
        }
        controlled_capacity = controlled_capacity
            .checked_add(capacity)
            .ok_or(ScriptError::ArithmeticOverflow)?;
    }
    if controlled_capacity != input_capacity {
        return Err(ScriptError::CapacityNotConserved);
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
