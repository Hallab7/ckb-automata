#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type_hash,
        load_script, load_script_hash,
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
mod campaign_generated {
    include!("../../generated/campaign_v1.rs");
}

mod error_codes {
    include!("../../shared/error_codes.rs");
}

use campaign_generated::CampaignDataV1;
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
    let input_count = QueryIter::new(load_cell_capacity, Source::GroupInput).count();
    let output_count = QueryIter::new(load_cell_capacity, Source::GroupOutput).count();
    match (input_count, output_count) {
        (0, 1) => validate_creation(),
        (1, 0) => validate_success(),
        _ => Err(ScriptError::InvalidApplicationState),
    }
}

fn campaign_type_hash() -> Result<[u8; 32], ScriptError> {
    let script = load_script().map_err(|_| ScriptError::InvalidData)?;
    let args = script.args().raw_data();
    args.as_ref()
        .try_into()
        .map_err(|_| ScriptError::InvalidData)
}

fn validate_creation() -> Result<(), ScriptError> {
    let data = load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&data).map_err(|_| ScriptError::InvalidData)?;
    let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    if job.policy_script_hash().as_slice() != script_hash
        || read_u16(job.version().as_slice()) != 1
        || read_u16(job.trigger_kind().as_slice()) != 1
        || read_u32(job.remaining_runs().as_slice()) != 1
        || read_u64(job.not_before().as_slice()) == 0
    {
        return Err(ScriptError::InvalidData);
    }
    campaign_type_hash()?;
    Ok(())
}

fn validate_success() -> Result<(), ScriptError> {
    let job_data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let job = JobDataV1::from_slice(&job_data).map_err(|_| ScriptError::InvalidData)?;
    let expected_campaign_type = campaign_type_hash()?;

    let mut campaign_index = None;
    for (index, type_hash) in QueryIter::new(load_cell_type_hash, Source::Input).enumerate() {
        if type_hash == Some(expected_campaign_type) {
            if campaign_index.is_some() {
                return Err(ScriptError::InvalidApplicationState);
            }
            campaign_index = Some(index);
        }
    }
    let campaign_index = campaign_index.ok_or(ScriptError::InvalidApplicationState)?;
    let campaign_data =
        load_cell_data(campaign_index, Source::Input).map_err(|_| ScriptError::InvalidData)?;
    let campaign =
        CampaignDataV1::from_slice(&campaign_data).map_err(|_| ScriptError::InvalidData)?;
    if campaign.state().as_slice() != [0]
        || read_u64(job.not_before().as_slice()) != read_u64(campaign.deadline_since().as_slice())
        || read_u64(campaign.pledged().as_slice()) < read_u64(campaign.target().as_slice())
    {
        return Err(ScriptError::InvalidApplicationState);
    }

    let mut success_lock_hash = [0_u8; 32];
    success_lock_hash.copy_from_slice(campaign.success_lock_hash().as_slice());
    let mut payout_count = 0;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == success_lock_hash {
            payout_count += 1;
            let capacity = load_cell_capacity(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let type_hash = load_cell_type_hash(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let data = load_cell_data(index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            if capacity != read_u64(campaign.pledged().as_slice())
                || type_hash.is_some()
                || !data.is_empty()
            {
                return Err(ScriptError::InvalidApplicationState);
            }
        }
    }
    if payout_count != 1 {
        return Err(ScriptError::InvalidApplicationState);
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
