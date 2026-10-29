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

mod dao_harvest_witness {
    include!("../../shared/dao_harvest_witness.rs");
}

use dao_harvest_witness::VaultOperation;
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
    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    let args = script.args().raw_data();
    if args.len() != 160 {
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
    validate_payload_commitment(args, job_input_index, &job)?;

    let dao_data =
        load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidDaoCell)?;
    if dao_data.len() != 8 || dao_data.iter().any(|byte| *byte != 0) != expect_withdrawing {
        return Err(ScriptError::InvalidDaoCell);
    }
    Ok(())
}

fn validate_payload_commitment(
    args: &[u8],
    job_input_index: usize,
    job: &JobDataV1,
) -> Result<(), ScriptError> {
    let witness = load_witness_args(job_input_index, Source::Input)
        .map_err(|_| ScriptError::PayloadHashMismatch)?;
    let envelope = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    if envelope.len() < 4 {
        return Err(ScriptError::PayloadHashMismatch);
    }
    let payload_size = u32::from_le_bytes(
        envelope[..4]
            .try_into()
            .map_err(|_| ScriptError::PayloadHashMismatch)?,
    ) as usize;
    if payload_size < 4 || payload_size > envelope.len() {
        return Err(ScriptError::PayloadHashMismatch);
    }
    let payload = DaoHarvestPayloadV1::from_slice(&envelope[..payload_size])
        .map_err(|_| ScriptError::InvalidData)?;
    let mut policy_hash = [0_u8; 32];
    policy_hash.copy_from_slice(job.policy_script_hash().as_slice());
    let payload_hash = dao_harvest::dao_harvest_payload_hash(&policy_hash, payload.as_slice())
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if job.payload_hash().as_slice() != payload_hash {
        return Err(ScriptError::PayloadHashMismatch);
    }
    let commitment = dao_harvest::vault_commitment(&[
        payload.version().as_slice(),
        payload.owner_lock_hash().as_slice(),
        payload.payout_lock_hash().as_slice(),
        payload.dao_type_hash().as_slice(),
        payload.principal_capacity().as_slice(),
        payload.executor_reward().as_slice(),
        payload.min_compensation().as_slice(),
        payload.prepare_buffer_epochs().as_slice(),
        payload.confirmation_margin_epochs().as_slice(),
        payload.total_cycles().as_slice(),
        payload.end_epoch_since().as_slice(),
    ])
    .ok_or(ScriptError::ArithmeticOverflow)?;
    if &args[128..160] != commitment.as_slice() {
        return Err(ScriptError::MissingBoundJob);
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
