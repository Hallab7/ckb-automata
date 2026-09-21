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

fn main() -> i8 {
    match program_entry() {
        Ok(()) => 0,
        Err(error) => error.into(),
    }
}

fn program_entry() -> Result<(), ScriptError> {
    let mode = load_owner_mode()?;
    match mode {
        MODE_CANCEL | MODE_RECOVER => validate_owner_exit(),
        _ => Err(ScriptError::InvalidWitnessMode),
    }
}

fn load_owner_mode() -> Result<u8, ScriptError> {
    let witness =
        load_witness_args(0, Source::GroupInput).map_err(|_| ScriptError::InvalidWitnessMode)?;
    let input_type = witness
        .input_type()
        .to_opt()
        .ok_or(ScriptError::InvalidWitnessMode)?;
    let bytes = input_type.raw_data();
    match bytes.as_ref() {
        [mode] => Ok(*mode),
        _ => Err(ScriptError::InvalidWitnessMode),
    }
}

fn validate_owner_exit() -> Result<(), ScriptError> {
    if QueryIter::new(load_cell_capacity, Source::GroupInput).count() != 1 {
        return Err(ScriptError::InvalidData);
    }

    let data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
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
