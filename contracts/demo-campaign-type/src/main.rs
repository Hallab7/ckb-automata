#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_occupied_capacity, load_script,
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
mod generated {
    include!("../../generated/campaign_v1.rs");
}

#[allow(dead_code)]
mod campaign {
    include!("../../shared/campaign.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

use error_codes::ScriptError;
use generated::CampaignDataV1;

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
    if input_count == 0 && output_count == 1 {
        return validate_creation();
    }
    Err(ScriptError::InvalidApplicationState)
}

fn validate_creation() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let campaign = CampaignDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;

    if read_u16(campaign.version().as_slice()) != 1 {
        return Err(ScriptError::UnsupportedVersion);
    }
    if campaign.state().as_slice() != [0] {
        return Err(ScriptError::InvalidState);
    }

    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    let args = script.args().raw_data();
    if args.len() != 32 || args.as_ref() != campaign.campaign_id().as_slice() {
        return Err(ScriptError::JobIdMismatch);
    }

    let pledged = read_u64(campaign.pledged().as_slice());
    let pledge_count = read_u32(campaign.pledge_count().as_slice());
    let target = read_u64(campaign.target().as_slice());
    let deadline_since = read_u64(campaign.deadline_since().as_slice());
    if target == 0
        || (pledged == 0) != (pledge_count == 0)
        || is_zero(campaign.campaign_id().as_slice())
        || is_zero(campaign.success_lock_hash().as_slice())
        || is_zero(campaign.refund_commitment().as_slice())
    {
        return Err(ScriptError::InvalidData);
    }
    if !campaign::is_absolute_block_deadline(deadline_since) {
        return Err(ScriptError::InvalidSince);
    }

    let witness =
        load_witness_args(0, Source::Input).map_err(|_| ScriptError::PayloadHashMismatch)?;
    let records = witness
        .output_type()
        .to_opt()
        .ok_or(ScriptError::PayloadHashMismatch)?
        .raw_data();
    if !campaign::validate_refund_records(
        &records,
        pledge_count,
        pledged,
        campaign.refund_commitment().as_slice(),
    ) {
        return Err(ScriptError::PayloadHashMismatch);
    }

    let capacity =
        load_cell_capacity(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let occupied = load_cell_occupied_capacity(0, Source::GroupOutput)
        .map_err(|_| ScriptError::InvalidData)?;
    let spendable = capacity
        .checked_sub(occupied)
        .ok_or(ScriptError::ArithmeticOverflow)?;
    if pledged != spendable {
        return Err(ScriptError::CapacityNotConserved);
    }
    Ok(())
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
