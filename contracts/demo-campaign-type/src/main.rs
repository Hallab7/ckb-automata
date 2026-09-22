#![no_main]
#![no_std]

use ckb_std::{
    ckb_constants::Source,
    default_alloc, entry,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock_hash,
        load_cell_occupied_capacity, load_cell_type_hash, load_input, load_input_since,
        load_script, load_script_hash, load_witness_args,
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

mod campaign_identity {
    include!("../../shared/campaign_identity.rs");
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
    match (input_count, output_count) {
        (0, 1) => validate_creation(),
        (1, 1) => validate_transition(),
        _ => Err(ScriptError::InvalidApplicationState),
    }
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
    let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
    let output_index = QueryIter::new(load_cell_type_hash, Source::Output)
        .position(|type_hash| type_hash == Some(script_hash))
        .and_then(|index| u32::try_from(index).ok())
        .ok_or(ScriptError::InvalidApplicationState)?;
    let anchor_input = load_input(0, Source::Input).map_err(|_| ScriptError::InvalidData)?;
    let anchor_out_point: [u8; 36] = anchor_input
        .previous_output()
        .as_slice()
        .try_into()
        .map_err(|_| ScriptError::InvalidData)?;
    if campaign.campaign_id().as_slice()
        != campaign_identity::derive_campaign_id(&anchor_out_point, output_index)
    {
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
    let output_lock = load_cell_lock_hash(0, Source::GroupOutput)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    if output_lock == campaign.success_lock_hash().as_slice() {
        return Err(ScriptError::InvalidApplicationState);
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

fn validate_transition() -> Result<(), ScriptError> {
    let input_data = load_cell_data(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let output_data =
        load_cell_data(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    let input = CampaignDataV1::from_slice(&input_data).map_err(|_| ScriptError::InvalidData)?;
    let output = CampaignDataV1::from_slice(&output_data).map_err(|_| ScriptError::InvalidData)?;

    if input.state().as_slice() != [0] || !matches!(output.state().as_slice(), [1] | [2]) {
        return Err(ScriptError::InvalidApplicationState);
    }
    for (before, after) in [
        (input.version().as_slice(), output.version().as_slice()),
        (
            input.campaign_id().as_slice(),
            output.campaign_id().as_slice(),
        ),
        (input.pledged().as_slice(), output.pledged().as_slice()),
        (
            input.pledge_count().as_slice(),
            output.pledge_count().as_slice(),
        ),
        (input.target().as_slice(), output.target().as_slice()),
        (
            input.deadline_since().as_slice(),
            output.deadline_since().as_slice(),
        ),
        (
            input.success_lock_hash().as_slice(),
            output.success_lock_hash().as_slice(),
        ),
        (
            input.refund_commitment().as_slice(),
            output.refund_commitment().as_slice(),
        ),
    ] {
        if before != after {
            return Err(ScriptError::SuccessorInvariantMismatch);
        }
    }

    let deadline = read_u64(input.deadline_since().as_slice());
    if !QueryIter::new(load_input_since, Source::Input).any(|since| since == deadline) {
        return Err(ScriptError::NotYetEligible);
    }

    let input_lock = load_cell_lock_hash(0, Source::GroupInput)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    let output_lock = load_cell_lock_hash(0, Source::GroupOutput)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    let mut success_lock_hash = [0_u8; 32];
    success_lock_hash.copy_from_slice(input.success_lock_hash().as_slice());
    if input_lock != output_lock || input_lock == success_lock_hash {
        return Err(ScriptError::InvalidApplicationState);
    }

    let outcome = campaign::determine_campaign_outcome(
        read_u64(input.pledged().as_slice()),
        read_u64(input.target().as_slice()),
    )
    .ok_or(ScriptError::InvalidApplicationState)?;
    let input_capacity =
        load_cell_capacity(0, Source::GroupInput).map_err(|_| ScriptError::InvalidData)?;
    let terminal_capacity =
        load_cell_capacity(0, Source::GroupOutput).map_err(|_| ScriptError::InvalidData)?;
    if output.state().as_slice() == [2] {
        if outcome != campaign::CampaignStateMarker::Refunding {
            return Err(ScriptError::InvalidApplicationState);
        }

        let witness = load_witness_args(0, Source::GroupInput)
            .map_err(|_| ScriptError::PayloadHashMismatch)?;
        let records = witness
            .input_type()
            .to_opt()
            .ok_or(ScriptError::PayloadHashMismatch)?
            .raw_data();
        let pledge_count = read_u32(input.pledge_count().as_slice());
        let pledged = read_u64(input.pledged().as_slice());
        if !campaign::validate_refund_records(
            &records,
            pledge_count,
            pledged,
            input.refund_commitment().as_slice(),
        ) {
            return Err(ScriptError::PayloadHashMismatch);
        }

        let script_hash = load_script_hash().map_err(|_| ScriptError::InvalidData)?;
        let terminal_index = QueryIter::new(load_cell_type_hash, Source::Output)
            .position(|type_hash| type_hash == Some(script_hash))
            .ok_or(ScriptError::InvalidApplicationState)?;
        let refund_start = terminal_index
            .checked_sub(pledge_count as usize)
            .ok_or(ScriptError::InvalidApplicationState)?;
        let mut expected_success_refunds = 0_usize;
        for (offset, record) in records
            .chunks_exact(campaign::PLEDGE_RECORD_SIZE)
            .enumerate()
        {
            let output_index = refund_start + offset;
            let expected_lock_hash = &record[36..68];
            let expected_amount = read_u64(&record[68..76]);
            let lock_hash = load_cell_lock_hash(output_index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let capacity = load_cell_capacity(output_index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let type_hash = load_cell_type_hash(output_index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            let data = load_cell_data(output_index, Source::Output)
                .map_err(|_| ScriptError::InvalidApplicationState)?;
            if lock_hash.as_slice() != expected_lock_hash
                || capacity != expected_amount
                || type_hash.is_some()
                || !data.is_empty()
            {
                return Err(ScriptError::InvalidApplicationState);
            }
            if expected_lock_hash == success_lock_hash {
                expected_success_refunds += 1;
            }
        }
        if QueryIter::new(load_cell_lock_hash, Source::Output)
            .filter(|lock_hash| *lock_hash == success_lock_hash)
            .count()
            != expected_success_refunds
        {
            return Err(ScriptError::InvalidApplicationState);
        }

        let terminal_occupied = load_cell_occupied_capacity(0, Source::GroupOutput)
            .map_err(|_| ScriptError::InvalidData)?;
        if terminal_capacity != terminal_occupied
            || input_capacity
                != terminal_capacity
                    .checked_add(pledged)
                    .ok_or(ScriptError::ArithmeticOverflow)?
        {
            return Err(ScriptError::CapacityNotConserved);
        }
        return Ok(());
    }
    if outcome != campaign::CampaignStateMarker::Succeeded {
        return Err(ScriptError::InvalidApplicationState);
    }

    let mut payout_index = None;
    for (index, lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate() {
        if lock_hash == success_lock_hash {
            if payout_index.is_some() {
                return Err(ScriptError::InvalidApplicationState);
            }
            payout_index = Some(index);
        }
    }
    let payout_index = payout_index.ok_or(ScriptError::InvalidApplicationState)?;
    let payout_capacity = load_cell_capacity(payout_index, Source::Output)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    let payout_type = load_cell_type_hash(payout_index, Source::Output)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    let payout_data = load_cell_data(payout_index, Source::Output)
        .map_err(|_| ScriptError::InvalidApplicationState)?;
    if payout_capacity != read_u64(input.pledged().as_slice())
        || payout_type.is_some()
        || !payout_data.is_empty()
    {
        return Err(ScriptError::InvalidApplicationState);
    }

    let terminal_occupied = load_cell_occupied_capacity(0, Source::GroupOutput)
        .map_err(|_| ScriptError::InvalidData)?;
    if terminal_capacity != terminal_occupied
        || input_capacity
            != terminal_capacity
                .checked_add(payout_capacity)
                .ok_or(ScriptError::ArithmeticOverflow)?
    {
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
