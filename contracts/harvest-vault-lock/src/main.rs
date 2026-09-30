#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_data, load_cell_lock_hash, load_script, load_script_hash,
        load_witness_args,
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

mod error_codes {
    include!("../../shared/error_codes.rs");
}

mod dao_harvest_witness {
    include!("../../shared/dao_harvest_witness.rs");
}

use dao_harvest_witness::VaultOperation;
use error_codes::ScriptError;
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
    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    let args = script.args().raw_data();
    if args.len() != 128 {
        return Err(ScriptError::InvalidData);
    }
    let operation = load_operation()?;
    match operation {
        VaultOperation::Prepare { job_input_index } => {
            validate_job_authority(&args, job_input_index, false)
        }
        VaultOperation::Roll { job_input_index } => {
            validate_job_authority(&args, job_input_index, true)
        }
        VaultOperation::OwnerStop | VaultOperation::OwnerExit | VaultOperation::OwnerRecover => {
            validate_owner_authority(&args)
        }
    }
}

fn load_operation() -> Result<VaultOperation, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let bytes = witness
        .lock()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?
        .raw_data();
    dao_harvest_witness::parse_vault_operation(&bytes).ok_or(ScriptError::InvalidWitnessMode)
}

fn validate_job_authority(
    args: &[u8],
    job_input_index: usize,
    expect_withdrawing: bool,
) -> Result<(), ScriptError> {
    let expected_job_lock: [u8; 32] = args[64..96]
        .try_into()
        .map_err(|_| ScriptError::InvalidData)?;
    let actual_job_lock = load_cell_lock_hash(job_input_index, Source::Input)
        .map_err(|_| ScriptError::MissingBoundJob)?;
    if actual_job_lock != expected_job_lock {
        return Err(ScriptError::MissingBoundJob);
    }
    let job_data =
        load_cell_data(job_input_index, Source::Input).map_err(|_| ScriptError::MissingBoundJob)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::MissingBoundJob)?;
    if job.job_id().as_slice() != &args[..32]
        || job.cancel_lock_hash().as_slice() != &args[32..64]
        || job.policy_script_hash().as_slice() != &args[96..128]
    {
        return Err(ScriptError::MissingBoundJob);
    }

    let dao_data =
        load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidDaoCell)?;
    if dao_data.len() != 8 || dao_data.iter().any(|byte| *byte != 0) != expect_withdrawing {
        return Err(ScriptError::InvalidDaoCell);
    }
    Ok(())
}

fn validate_owner_authority(args: &[u8]) -> Result<(), ScriptError> {
    let owner_hash: [u8; 32] = args[32..64]
        .try_into()
        .map_err(|_| ScriptError::InvalidData)?;
    let vault_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if owner_hash != vault_hash
        && QueryIter::new(load_cell_lock_hash, Source::Input)
            .any(|lock_hash| lock_hash == owner_hash && lock_hash != vault_hash)
    {
        Ok(())
    } else {
        Err(ScriptError::MissingOwnerAuthorization)
    }
}
